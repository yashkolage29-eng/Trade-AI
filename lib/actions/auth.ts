"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { AuthResponse } from "@/lib/types/auth";

export async function login(
  _prev: AuthResponse | null,
  formData: FormData
): Promise<AuthResponse> {
  const supabase = await createClient();

  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  if (!email || !password) {
    return { success: false, error: "Email and password are required." };
  }

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath("/dashboard");
  redirect("/dashboard");
}

export async function signup(
  _prev: AuthResponse | null,
  formData: FormData
): Promise<AuthResponse> {
  const supabase = await createClient();

  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const username = formData.get("username") as string;

  if (!email || !password || !username) {
    return { success: false, error: "All fields are required." };
  }

  if (password.length < 6) {
    return { success: false, error: "Password must be at least 6 characters." };
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { username },
    },
  });

  if (error) {
    return { success: false, error: error.message };
  }

  // Create profile row
  if (data.user) {
    await supabase.from("profiles").insert({
      id: data.user.id,
      username,
    });
  }

  // If no session, email confirmation is required — don't redirect
  if (!data.session) {
    return {
      success: true,
      data: { userId: data.user!.id, emailConfirmationNeeded: true },
    };
  }

  revalidatePath("/dashboard");
  redirect("/dashboard");
}

export async function signInWithOAuth(provider: "google" | "apple") {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001"}/auth/callback`,
    },
  });

  if (error) {
    return { success: false, error: error.message };
  }

  redirect(data.url);
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/");
  redirect("/auth/login");
}
