from dataclasses import dataclass

from google.auth.exceptions import GoogleAuthError, TransportError
from google.auth.transport import requests
from google.oauth2 import id_token

_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}


class InvalidGoogleToken(Exception):
    """The ID token is not a valid, verified Google identity for this app."""


class GoogleUnavailable(Exception):
    """Google's signing keys could not be fetched, so the token could not be checked."""


@dataclass(frozen=True)
class GoogleIdentity:
    sub: str
    email: str


def verify_google_id_token(token: str, client_id: str) -> GoogleIdentity:
    try:
        claims = id_token.verify_oauth2_token(token, requests.Request(), client_id)
    except TransportError as error:
        raise GoogleUnavailable from error
    except (ValueError, GoogleAuthError) as error:
        raise InvalidGoogleToken from error

    # The library checks signature, audience, expiry and issuer; we re-check the issuer and the
    # rest as defence in depth.
    sub = claims.get("sub")
    email = claims.get("email")
    if (
        claims.get("iss") not in _ISSUERS
        or claims.get("email_verified") is not True
        or not isinstance(sub, str)
        or not sub
        or not isinstance(email, str)
        or not email
    ):
        raise InvalidGoogleToken
    return GoogleIdentity(sub=sub, email=email.lower())
