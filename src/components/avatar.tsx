import { useEffect, useState } from "react";
import { cn, initials } from "@/lib/utils";

const AVATAR_STORAGE_KEY = "dzbuild.userAvatars.v1";
const AVATAR_CHANGE_EVENT = "dzbuild:user-avatar-changed";

export function readUserAvatarsMap(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(AVATAR_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function writeUserAvatar(userId: string, dataUrl: string | null): void {
  const next = readUserAvatarsMap();
  if (dataUrl) {
    next[userId] = dataUrl;
  } else {
    delete next[userId];
  }
  window.localStorage.setItem(AVATAR_STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(AVATAR_CHANGE_EVENT));
}

function useStoredUserAvatar(userId?: string | null): string | null {
  const [avatar, setAvatar] = useState<string | null>(() =>
    userId ? (readUserAvatarsMap()[userId] ?? null) : null,
  );

  useEffect(() => {
    if (!userId) {
      setAvatar(null);
      return;
    }
    const sync = () => setAvatar(readUserAvatarsMap()[userId] ?? null);
    sync();
    window.addEventListener(AVATAR_CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(AVATAR_CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [userId]);

  return avatar;
}

export function Avatar({
  name,
  userId,
  src,
  size = "md",
}: {
  name: string;
  userId?: string | null;
  src?: string | null;
  size?: "md" | "lg";
}) {
  const storedAvatar = useStoredUserAvatar(userId);
  const imageUrl = src !== undefined ? src : storedAvatar;
  const sizeClass = size === "lg" ? "size-16 text-2xl" : "size-11 text-lg";

  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt=""
        aria-hidden
        className={cn(
          "shrink-0 rounded-full border border-line object-cover",
          sizeClass,
        )}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-brand-soft font-bold text-ink",
        sizeClass,
      )}
    >
      {initials(name)}
    </span>
  );
}
