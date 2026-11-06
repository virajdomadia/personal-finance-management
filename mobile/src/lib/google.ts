// The only file that uses the Google sign-in library, so swapping it touches nothing else.
import {
  GoogleOneTapSignIn,
  isErrorWithCode,
  statusCodes,
} from "react-native-nitro-google-signin";

// The web OAuth client ID. It identifies the app to Google and isn't secret.
const WEB_CLIENT_ID = "267771117947-kknjiobm7pkhr689c56he5brc379u8tp.apps.googleusercontent.com";

/** Google sign-in failed for a reason other than the user backing out. */
export class GoogleSignInFailedError extends Error {}

let configured = false;

function configure() {
  if (configured) return;
  GoogleOneTapSignIn.configure({ webClientId: WEB_CLIENT_ID });
  configured = true;
}

/** Shows the account picker. Resolves with Google's ID token, or null if the user cancelled. */
export async function getGoogleIdToken(): Promise<string | null> {
  try {
    configure();
    const response = await GoogleOneTapSignIn.presentExplicitSignIn();
    if (response.type === "success" && response.data) return response.data.idToken;
    return null;
  } catch (error) {
    if (isErrorWithCode(error) && error.code === statusCodes.SIGN_IN_CANCELLED) return null;
    throw new GoogleSignInFailedError("Google sign-in failed.", { cause: error });
  }
}

/** Forgets the Google account so the picker appears next time. */
export async function signOutOfGoogle(): Promise<void> {
  try {
    configure();
    await GoogleOneTapSignIn.signOut();
  } catch {
    // Logging out must succeed even if Google's local state can't be cleared.
  }
}
