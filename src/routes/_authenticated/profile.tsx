import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Ban, Camera, ChevronRight, MapPin, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { FollowCounts } from "@/components/people/follow-counts";
import { UserAvatar } from "@/components/user-avatar";
import { amIAdmin, moderationKeys } from "@/lib/moderation";
import { supabase } from "@/integrations/supabase/client";
import { useMyProfile } from "@/hooks/use-my-profile";
import { uploadAvatar } from "@/lib/avatar";
import { friendKeys, profileStats, rpcErrorKey } from "@/lib/friends";
import { signOut } from "@/lib/sign-out";

export const Route = createFileRoute("/_authenticated/profile")({
  component: MyProfilePage,
});

const USERNAME = /^[a-z0-9._]{3,20}$/;

/** Your profile: photo, name, @username, bio (edit in place), counts, location settings, sign out. */
function MyProfilePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMyProfile();
  const stats = useQuery({ queryKey: friendKeys.stats(me.data?.id ?? ""), queryFn: () => profileStats(me.data!.id), enabled: !!me.data });
  const admin = useQuery({ queryKey: moderationKeys.admin, queryFn: amIAdmin });
  const [form, setForm] = useState({ full_name: "", username: "", bio: "" });
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (me.data) setForm({ full_name: me.data.full_name, username: me.data.username, bio: me.data.bio });
  }, [me.data]);

  const dirty = !!me.data && (form.full_name !== me.data.full_name || form.username !== me.data.username || form.bio !== me.data.bio);
  const valid = USERNAME.test(form.username) && form.full_name.trim().length <= 60 && form.bio.length <= 160;

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: form.full_name.trim(), username: form.username, bio: form.bio.trim() })
        .eq("id", me.data!.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success(t("common.saved"));
      void qc.invalidateQueries({ queryKey: friendKeys.me });
    },
    onError: (e) => toast.error(t(rpcErrorKey(e))),
  });
  const photo = useMutation({
    mutationFn: (f: File) => uploadAvatar(me.data!.id, f),
    onSuccess: () => void qc.invalidateQueries({ queryKey: friendKeys.me }),
    onError: (e) => {
      const key = e instanceof Error && e.message.startsWith("image_") ? `profile.errors.${e.message}` : "errors.generic";
      toast.error(t(key));
    },
  });

  async function leave() {
    await signOut(qc);
    void navigate({ to: "/login", replace: true });
  }

  const p = me.data;
  return (
    <>
      <AppHeader large={t("profile.title")} />
      {p && (
        <div className="space-y-6 px-4 pb-8 pt-2">
          <div className="flex items-center gap-4">
            <button type="button" onClick={() => file.current?.click()} className="relative" aria-label={t("profile.photo")}>
              <UserAvatar name={p.full_name || p.username} path={p.avatar_path} size={80} />
              <span className="absolute -bottom-1 -right-1 grid h-8 w-8 place-items-center rounded-full border-2 border-background bg-primary text-primary-foreground">
                <Camera className="h-4 w-4" />
              </span>
            </button>
            <input
              ref={file}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) photo.mutate(f);
              }}
            />
            <div className="min-w-0">
              <p className="truncate text-tagline">{p.full_name || p.username}</p>
              <p className="truncate text-callout text-muted-foreground">@{p.username}</p>
              {stats.data && <FollowCounts userId={p.id} stats={stats.data} className="mt-1" />}
            </div>
          </div>

          <section className="space-y-3">
            <h2 className="text-callout font-semibold text-muted-foreground">{t("profile.edit")}</h2>
            <label className="block">
              <span className="mb-1 block text-caption font-semibold text-muted-foreground">{t("auth.fullName")}</span>
              <input
                value={form.full_name}
                maxLength={60}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                className="h-12 w-full rounded-xl border border-input bg-background px-4"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-caption font-semibold text-muted-foreground">{t("auth.username")}</span>
              <input
                value={form.username}
                maxLength={20}
                autoCapitalize="none"
                onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase().replace(/\s/g, "") })}
                className="h-12 w-full rounded-xl border border-input bg-background px-4"
              />
              {!USERNAME.test(form.username) && <span className="mt-1 block text-fine text-destructive">{t("rpcErrors.usernameFormat")}</span>}
            </label>
            <label className="block">
              <span className="mb-1 block text-caption font-semibold text-muted-foreground">{t("profile.bio")}</span>
              <textarea
                value={form.bio}
                maxLength={160}
                rows={3}
                onChange={(e) => setForm({ ...form, bio: e.target.value })}
                className="w-full rounded-xl border border-input bg-background px-4 py-3"
              />
              <span className="mt-1 block text-fine text-muted-foreground">{t("profile.bioHint")}</span>
            </label>
            <button
              type="button"
              disabled={!dirty || !valid || save.isPending}
              onClick={() => save.mutate()}
              className="h-12 w-full rounded-full bg-primary font-semibold text-primary-foreground disabled:opacity-40"
            >
              {t("common.save")}
            </button>
          </section>

          <div className="divide-y divide-border overflow-hidden rounded-2xl bg-card">
            <Link to="/location" className="flex items-center gap-3 px-4 py-3.5">
              <MapPin className="h-5 w-5 text-link" />
              <span className="flex-1 font-semibold">{t("profile.location")}</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>
            <Link to="/blocked" className="flex items-center gap-3 px-4 py-3.5">
              <Ban className="h-5 w-5 text-muted-foreground" />
              <span className="flex-1 font-semibold">{t("blocked.title")}</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>
            {admin.data && (
              <Link to="/admin" className="flex items-center gap-3 px-4 py-3.5">
                <ShieldCheck className="h-5 w-5 text-link" />
                <span className="flex-1 font-semibold">{t("admin.title")}</span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
            )}
          </div>

          <button type="button" onClick={() => void leave()} className="h-12 w-full rounded-full bg-secondary font-semibold text-destructive">
            {t("auth.signOut")}
          </button>
        </div>
      )}
    </>
  );
}
