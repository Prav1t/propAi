"use server";
import { z } from "zod";
import { runOrgForm } from "@/server/form-action";
import { connectIntegration, disconnectIntegration, testIntegration } from "@/server/integrations/service";
import type { ActionState } from "@/server/actions";

const anyFields = z.record(z.string(), z.string());
const page = (slug: string) => [`/o/${slug}/settings/integrations`];

export async function connectIntegrationAction(slug: string, key: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: anyFields, recentAuth: true, run: (ctx, v) => connectIntegration(ctx, key, v), done: () => ({ message: "Connected. Send a test to check it.", revalidate: page(slug) }) });
}

export async function testIntegrationAction(slug: string, key: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: anyFields, run: (ctx, v) => testIntegration(ctx, key, { to: v.to }), done: (message) => ({ message, revalidate: page(slug) }) });
}

export async function disconnectIntegrationAction(slug: string, key: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: anyFields, allowReadOnly: true, run: (ctx) => disconnectIntegration(ctx, key), done: () => ({ message: "Disconnected.", revalidate: page(slug) }) });
}
