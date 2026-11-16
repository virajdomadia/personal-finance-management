import { router } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { setProfileGoneHandler, setRequestProfile } from "@/lib/api";
import { type Family, PROFILE_KEY, type Profile, parseStoredProfile, storedProfileValue } from "@/lib/family";
import { useSession } from "@/lib/session";

// Which profile the app is acting for: the signed-in owner (null) or one of their family members.
// The choice is remembered on the phone and sent as X-Profile on every request (see api.ts).

type Target = "/" | "/investments";

type ProfileState = {
  profile: Profile | null;
  // Changes whenever the profile does; the tabs are keyed on it so every screen starts afresh.
  profileKey: string;
  switchProfile: (next: Profile | null, to?: Target) => void;
  // Keeps the choice in step with a freshly loaded family list: a renamed member's new name, or
  // back to the owner when the chosen member is gone.
  syncFamily: (family: Family) => void;
};

const ProfileContext = createContext<ProfileState | null>(null);

function readStored(): Profile | null {
  try {
    return parseStoredProfile(SecureStore.getItem(PROFILE_KEY));
  } catch {
    return null;
  }
}

function store(profile: Profile | null): void {
  try {
    if (profile === null) SecureStore.deleteItemAsync(PROFILE_KEY).catch(() => undefined);
    else SecureStore.setItem(PROFILE_KEY, storedProfileValue(profile));
  } catch {
    // Not remembered; the choice still holds until the app restarts.
  }
}

// Closes any screen above the tabs and opens the first tab (or the one asked for).
function goHome(to: Target): void {
  try {
    if (router.canDismiss()) router.dismissAll();
    router.navigate(to);
  } catch {
    // Navigation isn't ready yet (the app is starting); it opens on the first tab anyway.
  }
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { token } = useSession();
  const [profile, setProfile] = useState<Profile | null>(() => {
    const stored = token === null ? null : readStored();
    setRequestProfile(stored?.id ?? null); // before any screen's first request
    return stored;
  });
  const current = useRef(profile);

  const switchProfile = useCallback((next: Profile | null, to: Target = "/") => {
    setRequestProfile(next?.id ?? null);
    store(next);
    current.current = next;
    setProfile(next);
    goHome(to);
  }, []);

  const syncFamily = useCallback(
    (family: Family) => {
      const chosen = current.current;
      if (chosen === null) return;
      const found = family.members.find((m) => m.id === chosen.id);
      if (!found) {
        switchProfile(null);
      } else if (found.name !== chosen.name) {
        const renamed = { id: found.id, name: found.name };
        store(renamed);
        current.current = renamed;
        setProfile(renamed); // the same id, so the screens stay as they are
      }
    },
    [switchProfile],
  );

  // A member removed on another device: back to the owner, on the first tab.
  useEffect(() => {
    setProfileGoneHandler((id) => {
      if (current.current?.id === id) switchProfile(null);
    });
    return () => setProfileGoneHandler(null);
  }, [switchProfile]);

  // Logging out forgets the choice, so the next sign-in starts as the owner.
  useEffect(() => {
    if (token !== null || current.current === null) return;
    setRequestProfile(null);
    store(null);
    current.current = null;
    setProfile(null);
  }, [token]);

  const value = useMemo(
    () => ({ profile, profileKey: profile === null ? "me" : `member-${profile.id}`, switchProfile, syncFamily }),
    [profile, switchProfile, syncFamily],
  );
  return <ProfileContext value={value}>{children}</ProfileContext>;
}

export function useProfile(): ProfileState {
  const state = use(ProfileContext);
  if (!state) throw new Error("useProfile must be used inside ProfileProvider.");
  return state;
}
