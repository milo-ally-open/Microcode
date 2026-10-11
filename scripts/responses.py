"""Call Microcode's OpenAI Responses-compatible gateway endpoint.

The default token and model are mock placeholders. Set the environment
variables below before this example makes any network request:

    MICROCODE_GATEWAY_TOKEN=<token from `microcode gateway token`>
    MICROCODE_GATEWAY_MODEL=<model id from `GET /v1/models`>

Install the client SDK with: python -m pip install openai
"""

from __future__ import annotations

import os
import sys


GATEWAY_URL = os.getenv("MICROCODE_GATEWAY_URL", "http://127.0.0.1:43127").rstrip("/")
GATEWAY_TOKEN = os.getenv("MICROCODE_GATEWAY_TOKEN", "mock-gateway-token")
MODEL = os.getenv("MICROCODE_GATEWAY_MODEL", "provider/mock-model")


def main() -> int:
    if GATEWAY_TOKEN == "mock-gateway-token" or MODEL == "provider/mock-model":
        print(
            "Mock configuration only; set MICROCODE_GATEWAY_TOKEN and "
            "MICROCODE_GATEWAY_MODEL to make a request.",
            file=sys.stderr,
        )
        return 0

    from openai import OpenAI

    client = OpenAI(
        base_url=f"{GATEWAY_URL}/v1",
        api_key=GATEWAY_TOKEN,
    )
    response = client.responses.create(
        model=MODEL,
        input="Who are you? Briefly introduce yourself in one sentence.",
        max_output_tokens=128,
    )

    print(response.output_text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
