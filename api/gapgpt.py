"""Shared GapGPT client (OpenAI-compatible chat completions).

Later tickets (recipe generation, fridge vision) should call ``GapGPTClient.chat``.
Configuration comes only from the environment:

  GAP_CODE_API_KEY   required to call the API; never logged or returned
  GAPGPT_BASE_URL    default https://api.gapgpt.app/v1
  GAPGPT_MODEL       default gpt-5.6-luna

The key is attached only as an ``Authorization`` header. It is not written to
logs, error messages, response bodies, or ``repr``.
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Mapping, NoReturn

DEFAULT_BASE_URL = "https://api.gapgpt.app/v1"
DEFAULT_MODEL = "gpt-5.6-luna"
KEY_ENV = "GAP_CODE_API_KEY"
BASE_URL_ENV = "GAPGPT_BASE_URL"
MODEL_ENV = "GAPGPT_MODEL"

DEFAULT_TIMEOUT_SECONDS = 60.0
MAX_RESPONSE_BYTES = 2_000_000
# Avoid rewriting ordinary words when a configured value is implausibly short.
_MIN_REDACT_LEN = 8
SMOKE_PROMPT = "Reply with exactly: pong"
_BLOCKED_OPTIONS = frozenset(
    {
        "api_key",
        "apikey",
        "authorization",
        "gap_code_api_key",
    }
)

Transport = Callable[[urllib.request.Request, float], Any]


class GapGPTError(Exception):
    """Controlled failure safe to return to callers. Never carries the API key."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        http_status: int = 502,
        upstream_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.upstream_status = upstream_status

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "ok": False,
            "error": self.code,
            "message": self.message,
        }
        if self.upstream_status is not None:
            body["upstream_status"] = self.upstream_status
        return body


def _env_str(env: Mapping[str, str], name: str, default: str) -> str:
    raw = env.get(name)
    if raw is None:
        return default
    value = raw.strip()
    return value or default


def _url_without_userinfo(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    if not parts.netloc or (parts.username is None and parts.password is None):
        return url
    host = parts.hostname or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = f"{host}:{parts.port}" if parts.port else host
    return urllib.parse.urlunsplit(
        (parts.scheme, netloc, parts.path, parts.query, parts.fragment)
    )


@dataclass(frozen=True)
class GapGPTConfig:
    api_key: str
    base_url: str
    model: str

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> GapGPTConfig:
        env = os.environ if environ is None else environ
        return cls(
            api_key=_env_str(env, KEY_ENV, ""),
            base_url=_env_str(env, BASE_URL_ENV, DEFAULT_BASE_URL).rstrip("/"),
            model=_env_str(env, MODEL_ENV, DEFAULT_MODEL),
        )

    def redact(self, value: str) -> str:
        key = self.api_key
        if (
            not isinstance(value, str)
            or len(key) < _MIN_REDACT_LEN
            or key not in value
        ):
            return value
        return value.replace(key, "[redacted]")

    def public_status(self) -> dict[str, Any]:
        return {
            "configured": self.configured,
            "base_url": self.redact(_url_without_userinfo(self.base_url)),
            "model": self.redact(self.model),
        }

    def __repr__(self) -> str:
        status = self.public_status()
        return (
            "GapGPTConfig("
            f"configured={status['configured']}, "
            f"base_url={status['base_url']!r}, "
            f"model={status['model']!r})"
        )

    __str__ = __repr__


class _QuietHTTPHandler(urllib.request.HTTPHandler):
    """HTTP handler with debug output forced off (debug logs include headers)."""

    def __init__(self) -> None:
        super().__init__(debuglevel=0)


class _QuietHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self) -> None:
        super().__init__(debuglevel=0)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse redirects so the Authorization header cannot follow a new host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)


def _make_transport() -> Transport:
    opener = urllib.request.build_opener(
        _QuietHTTPHandler(),
        _QuietHTTPSHandler(),
        _NoRedirect(),
    )

    def _open(request: urllib.request.Request, timeout: float):
        return opener.open(request, timeout=timeout)

    return _open


def _contains_secret(value: Any, secret: str) -> bool:
    if len(secret) < _MIN_REDACT_LEN:
        return False
    if isinstance(value, str):
        return secret in value
    if isinstance(value, list):
        return any(_contains_secret(item, secret) for item in value)
    if isinstance(value, dict):
        return any(
            _contains_secret(key, secret) or _contains_secret(item, secret)
            for key, item in value.items()
        )
    return False


def _redact_json(value: Any, config: GapGPTConfig) -> Any:
    if isinstance(value, str):
        return config.redact(value)
    if isinstance(value, list):
        return [_redact_json(item, config) for item in value]
    if isinstance(value, dict):
        return {
            config.redact(str(key)): _redact_json(item, config)
            for key, item in value.items()
        }
    return value


def _discard(response: Any) -> None:
    read = getattr(response, "read", None)
    if callable(read):
        try:
            read()
        except Exception:
            pass
    close = getattr(response, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass


def _status_of(response: Any) -> int:
    for attr in ("status", "code"):
        value = getattr(response, attr, None)
        if isinstance(value, int):
            return value
    return 200


def _read_limited(response: Any) -> Any:
    read = response.read
    try:
        return read(MAX_RESPONSE_BYTES + 1)
    except TypeError:
        return read()


def message_text(body: Mapping[str, Any]) -> str:
    """Return assistant text from a chat-completions JSON object."""
    try:
        content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise GapGPTError(
            "bad_response",
            "GapGPT response did not include a message",
            http_status=502,
        ) from None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        if parts:
            return "".join(parts)
    raise GapGPTError(
        "bad_response",
        "GapGPT response did not include text content",
        http_status=502,
    ) from None


class GapGPTClient:
    def __init__(
        self,
        config: GapGPTConfig | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: Transport | None = None,
    ) -> None:
        if not isinstance(timeout, (int, float)) or timeout <= 0:
            raise ValueError("timeout must be positive")
        self.config = config if config is not None else GapGPTConfig.from_env()
        self.timeout = float(timeout)
        self._transport = transport if transport is not None else _make_transport()

    def __repr__(self) -> str:
        return f"GapGPTClient(config={self.config!r}, timeout={self.timeout!r})"

    def chat(
        self,
        messages: list,
        *,
        model: str | None = None,
        **options: Any,
    ) -> dict[str, Any]:
        """POST ``/chat/completions`` and return the JSON object.

        ``messages`` uses the OpenAI chat format. ``content`` may be a string
        or a list of parts (for later vision calls). Extra keyword arguments
        are copied into the JSON body (for example ``temperature``).
        """
        self._check_ready()
        self._validate_messages(messages)
        self._reject_options(options)
        payload: dict[str, Any] = {
            "model": self._choose_model(model),
            "messages": messages,
        }
        payload.update(options)
        if _contains_secret(payload, self.config.api_key):
            self._raise(
                "invalid_request",
                "request must not include the API key",
                http_status=400,
            )
        response = self._call(self._build_request(payload))
        status, raw = self._read(response)
        if status >= 400:
            self._raise_for_http_status(status)
        body = self._parse(raw, status)
        if "error" in body and "choices" not in body:
            self._raise(
                "upstream_error",
                "GapGPT returned an error",
                http_status=502,
                upstream_status=status,
            )
        return body

    def chat_text(
        self,
        messages: list,
        *,
        model: str | None = None,
        **options: Any,
    ) -> str:
        """Return the assistant text from ``chat``."""
        return message_text(self.chat(messages, model=model, **options))

    def smoke(self) -> dict[str, Any]:
        """Send one fixed prompt. Does not accept caller-supplied messages."""
        reply = self.config.redact(self.chat_text(_smoke_messages()).strip())
        if len(reply) > 2000:
            reply = reply[:2000]
        status = self.config.public_status()
        return {
            "ok": True,
            "model": status["model"],
            "base_url": status["base_url"],
            "reply": reply,
        }

    def _raise(
        self,
        code: str,
        message: str,
        *,
        http_status: int,
        upstream_status: int | None = None,
    ) -> NoReturn:
        raise GapGPTError(
            code,
            self.config.redact(message),
            http_status=http_status,
            upstream_status=upstream_status,
        ) from None

    def _check_ready(self) -> None:
        key = self.config.api_key
        if not key:
            self._raise(
                "not_configured",
                "GAP_CODE_API_KEY is not set",
                http_status=503,
            )
        if any(ord(ch) < 32 or ord(ch) == 127 or ch.isspace() for ch in key):
            self._raise(
                "invalid_config",
                "GAP_CODE_API_KEY contains characters that are not allowed",
                http_status=500,
            )
        try:
            key.encode("latin-1")
        except UnicodeEncodeError:
            self._raise(
                "invalid_config",
                "GAP_CODE_API_KEY contains characters that are not allowed",
                http_status=500,
            )
        if len(key) >= _MIN_REDACT_LEN and (
            key in self.config.base_url or key in self.config.model
        ):
            self._raise(
                "invalid_config",
                "GAPGPT_BASE_URL and GAPGPT_MODEL must not include the API key",
                http_status=500,
            )
        parts = urllib.parse.urlsplit(self.config.base_url)
        if parts.username is not None or parts.password is not None:
            self._raise(
                "invalid_config",
                "GAPGPT_BASE_URL must not include userinfo",
                http_status=500,
            )
        if parts.scheme not in ("http", "https") or not parts.netloc:
            self._raise(
                "invalid_config",
                "GAPGPT_BASE_URL must be an absolute http(s) URL",
                http_status=500,
            )

    def _validate_messages(self, messages: Any) -> None:
        if not isinstance(messages, list) or not messages:
            self._raise(
                "invalid_request",
                "messages must be a non-empty list",
                http_status=400,
            )
        for message in messages:
            if not isinstance(message, dict) or (
                "role" not in message or "content" not in message
            ):
                self._raise(
                    "invalid_request",
                    "each message needs role and content",
                    http_status=400,
                )
            role = message["role"]
            if not isinstance(role, str) or not role.strip():
                self._raise(
                    "invalid_request",
                    "message role must be a non-empty string",
                    http_status=400,
                )
            content = message["content"]
            if isinstance(content, str):
                continue
            if isinstance(content, list) and content:
                if all(isinstance(part, (str, dict)) for part in content):
                    continue
            self._raise(
                "invalid_request",
                "message content must be a string or a non-empty list of parts",
                http_status=400,
            )

    def _reject_options(self, options: Mapping[str, Any]) -> None:
        for name in options:
            normalized = str(name).lower().replace("-", "_")
            if normalized in _BLOCKED_OPTIONS:
                self._raise(
                    "invalid_request",
                    "request options must not include credentials",
                    http_status=400,
                )
        stream = options.get("stream")
        if stream is True or (isinstance(stream, str) and stream.lower() == "true"):
            self._raise(
                "invalid_request",
                "streaming is not supported",
                http_status=400,
            )

    def _choose_model(self, model: str | None) -> str:
        chosen = model.strip() if isinstance(model, str) else ""
        if not chosen:
            chosen = self.config.model
        if not isinstance(chosen, str) or not chosen.strip():
            self._raise(
                "invalid_config",
                "GAPGPT_MODEL is not set",
                http_status=500,
            )
        chosen = chosen.strip()
        key = self.config.api_key
        if len(key) >= _MIN_REDACT_LEN and key in chosen:
            self._raise(
                "invalid_config",
                "GAPGPT_MODEL must not include the API key",
                http_status=500,
            )
        return chosen

    def _build_request(self, payload: Mapping[str, Any]) -> urllib.request.Request:
        url = f"{self.config.base_url.rstrip('/')}/chat/completions"
        try:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        except (TypeError, ValueError):
            self._raise(
                "invalid_request",
                "request could not be encoded as JSON",
                http_status=400,
            )
        request = urllib.request.Request(url, data=data, method="POST")
        # unredirected: urllib will not copy this header onto a redirected request.
        request.add_unredirected_header(
            "Authorization", f"Bearer {self.config.api_key}"
        )
        request.add_unredirected_header("Content-Type", "application/json")
        request.add_unredirected_header("Accept", "application/json")
        return request

    def _call(self, request: urllib.request.Request) -> Any:
        try:
            return self._transport(request, self.timeout)
        except GapGPTError:
            raise
        except urllib.error.HTTPError as exc:
            status = exc.code if isinstance(exc.code, int) else None
            _discard(exc)
            self._raise_for_http_status(status)
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", None)
            if isinstance(reason, TimeoutError):
                self._raise(
                    "timeout",
                    "GapGPT request timed out",
                    http_status=504,
                )
            self._raise(
                "upstream_unavailable",
                "GapGPT could not be reached",
                http_status=502,
            )
        except TimeoutError:
            self._raise(
                "timeout",
                "GapGPT request timed out",
                http_status=504,
            )
        except OSError:
            self._raise(
                "upstream_unavailable",
                "GapGPT could not be reached",
                http_status=502,
            )
        except Exception:
            self._raise(
                "upstream_error",
                "GapGPT request failed",
                http_status=502,
            )

    def _raise_for_http_status(self, status: int | None) -> NoReturn:
        if status in (401, 403):
            self._raise(
                "unauthorized",
                "GapGPT rejected the API key",
                http_status=502,
                upstream_status=status,
            )
        self._raise(
            "upstream_error",
            "GapGPT rejected the request",
            http_status=502,
            upstream_status=status,
        )

    def _read(self, response: Any) -> tuple[int, bytes]:
        if response is None:
            self._raise(
                "upstream_error",
                "GapGPT request failed",
                http_status=502,
            )
        manager = (
            response if hasattr(response, "__enter__") else _NullContext(response)
        )
        try:
            with manager:
                status = _status_of(response)
                raw = _read_limited(response)
        except GapGPTError:
            raise
        except Exception:
            self._raise(
                "upstream_error",
                "GapGPT request failed",
                http_status=502,
            )
        if isinstance(raw, str):
            raw = raw.encode("utf-8")
        if not isinstance(raw, (bytes, bytearray)):
            self._raise(
                "bad_response",
                "GapGPT returned a non-JSON response",
                http_status=502,
                upstream_status=status,
            )
        if len(raw) > MAX_RESPONSE_BYTES:
            self._raise(
                "bad_response",
                "GapGPT response was too large",
                http_status=502,
                upstream_status=status,
            )
        return status, bytes(raw)

    def _parse(self, raw: bytes, status: int) -> dict[str, Any]:
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._raise(
                "bad_response",
                "GapGPT returned a non-JSON response",
                http_status=502,
                upstream_status=status,
            )
        if not isinstance(body, dict):
            self._raise(
                "bad_response",
                "GapGPT returned an unexpected response",
                http_status=502,
                upstream_status=status,
            )
        redacted = _redact_json(body, self.config)
        if not isinstance(redacted, dict):
            self._raise(
                "bad_response",
                "GapGPT returned an unexpected response",
                http_status=502,
                upstream_status=status,
            )
        return redacted


class _NullContext:
    def __init__(self, value: Any) -> None:
        self._value = value

    def __enter__(self) -> Any:
        return self._value

    def __exit__(self, *args: object) -> bool:
        close = getattr(self._value, "close", None)
        if callable(close):
            close()
        return False


def _smoke_messages() -> list[dict[str, str]]:
    return [{"role": "user", "content": SMOKE_PROMPT}]


def main(argv: list[str] | None = None) -> int:
    """CLI: ``status`` prints public config; ``smoke`` runs one chat call."""
    parser = argparse.ArgumentParser(
        description="GapGPT client checks. Reads configuration from the environment."
    )
    parser.add_argument("command", choices=("status", "smoke"))
    args = parser.parse_args(argv)
    if args.command == "status":
        print(
            json.dumps(GapGPTConfig.from_env().public_status(), ensure_ascii=False)
        )
        return 0
    try:
        result = GapGPTClient().smoke()
    except GapGPTError as exc:
        print(json.dumps(exc.to_dict(), ensure_ascii=False))
        return 1
    except Exception:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "internal_error",
                    "message": "GapGPT smoke check failed",
                },
                ensure_ascii=False,
            )
        )
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
