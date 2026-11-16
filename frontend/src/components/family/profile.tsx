"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";

import { apiFetch } from "@/lib/api";
import {
  type Family,
  type Person,
  pathAfterSwitch,
  profileCookie,
  readProfileCookie,
  viewedMember,
  viewingText,
} from "@/lib/family";
import { buttonClass } from "@/components/ui/chunky";

type FamilyStatus = "loading" | "error" | "ready";

type Profile = {
  // False until the cookie has been read in the browser; pages prerender as the owner's.
  ready: boolean;
  // A family member is chosen. Known from the cookie before the family list arrives.
  viewingMember: boolean;
  // The chosen member, once the family list has loaded.
  member: Person | null;
  family: Family | null;
  familyStatus: FamilyStatus;
  reloadFamily: () => void;
  setFamily: (family: Family) => void;
  // Chooses a member (or the owner, with null) and reloads the page for them.
  switchTo: (id: number | null) => void;
};

const ProfileContext = createContext<Profile | null>(null);

export function useProfile(): Profile {
  const profile = useContext(ProfileContext);
  if (!profile) throw new Error("useProfile is used outside ProfileProvider");
  return profile;
}

// The cookie only changes through switchTo, which reloads the page, so nothing needs to subscribe.
const subscribe = () => () => {};
const readCookie = () => readProfileCookie(document.cookie);
const notRead = () => undefined;

function setProfileCookie(id: number | null) {
  document.cookie = profileCookie(id, window.location.protocol === "https:");
}

// A full load, so every page and every request starts over for the new profile.
export function switchProfile(id: number | null) {
  setProfileCookie(id);
  window.location.assign(pathAfterSwitch(window.location.pathname));
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const profileId = useSyncExternalStore<number | null | undefined>(subscribe, readCookie, notRead);
  const [family, setFamilyState] = useState<Family | null>(null);
  const [familyStatus, setFamilyStatus] = useState<FamilyStatus>("loading");

  const reloadFamily = useCallback(() => {
    apiFetch<Family>("/family")
      .then((data) => {
        setFamilyState(data);
        setFamilyStatus("ready");
      })
      .catch(() => setFamilyStatus((s) => (s === "ready" ? s : "error")));
  }, []);

  useEffect(() => {
    reloadFamily();
  }, [reloadFamily]);

  const { member, stale } = viewedMember(family, profileId ?? null);

  // The chosen member is gone (removed elsewhere): back to the owner.
  useEffect(() => {
    if (stale) {
      setProfileCookie(null);
      window.location.reload();
    }
  }, [stale]);

  const setFamily = useCallback((data: Family) => {
    setFamilyState(data);
    setFamilyStatus("ready");
  }, []);

  const value: Profile = {
    ready: profileId !== undefined,
    viewingMember: profileId != null && !stale && (family === null || profileId !== family.me.id),
    member,
    family,
    familyStatus,
    reloadFamily,
    setFamily,
    switchTo: switchProfile,
  };
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

// On every page while a member is chosen, so nothing of the owner's is recorded into theirs by
// mistake. It stays at the top of the screen as the page scrolls.
export function ViewingBar() {
  const { viewingMember, member, switchTo } = useProfile();
  if (!viewingMember) return null;
  return (
    <div
      role="region"
      aria-label="Profile you are viewing"
      className="sticky top-0 z-30 -mx-4 -mt-4 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-b-[2.5px] border-ink bg-purple-strong px-4 py-2.5 text-white sm:-mx-6 sm:-mt-6 sm:mb-6 sm:px-6"
    >
      <p className="min-w-0 flex-1 text-sm font-black [overflow-wrap:anywhere]">
        <span aria-hidden="true">👀 </span>
        {viewingText(member?.name ?? null)}
      </p>
      <button type="button" className={`${buttonClass("alt")} !px-3 !py-1.5 uppercase`} onClick={() => switchTo(null)}>
        Back to me
      </button>
    </div>
  );
}
