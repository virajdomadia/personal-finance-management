// The app's entry. Registers what must exist even when Android starts the app with no screen (the
// SMS arrival task), then hands over to Expo Router, which must be imported last.
import "./src/lib/sms/register-background";

import "expo-router/entry";
