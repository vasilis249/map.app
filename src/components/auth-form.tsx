import type { FormEvent, ReactNode } from "react";
import { APP_NAME } from "@/lib/brand";

/** The frame of the sign-in / sign-up screens: name, tagline, the form, a link below. */
export function AuthFrame({ title, tagline, onSubmit, children, footer }: {
  title: string;
  tagline: string;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="safe-top mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-10">
      <p className="text-hero">{APP_NAME}</p>
      <p className="mt-1 text-callout text-muted-foreground">{tagline}</p>
      <form onSubmit={onSubmit} className="mt-8 space-y-3" noValidate>
        <h1 className="text-tagline">{title}</h1>
        {children}
      </form>
      <div className="mt-6 text-center text-callout text-muted-foreground">{footer}</div>
    </main>
  );
}

export function Field({ label, hint, ...input }: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1 block text-caption font-semibold text-muted-foreground">{label}</span>
      <input
        {...input}
        className="h-12 w-full rounded-xl border border-input bg-background px-4 text-body outline-none placeholder:text-muted-foreground"
      />
      {hint && <span className="mt-1 block text-fine text-muted-foreground">{hint}</span>}
    </label>
  );
}
