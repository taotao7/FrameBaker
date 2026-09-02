import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import { db } from "../../db";
import { createGenerationJobs } from "../../queue";
import { checkVideoSupport, resolveReferencePaths } from "../../providerAdapter";
import { ok, err } from "../helpers";

export function register(server: McpServer) {
  server.registerTool(
    "generate_frames",
    {
      title: "Generate Frames",
      description:
        "Generate frames for a project using an AI generation provider (CLI/API/DashScope/Gemini/MiniMax). Each requested image becomes an independently scheduled job; returns jobId (first job) and jobIds (all jobs). Poll with get_job or listen for completion. Supports up to 10 ordered reference images, provider selection, model, size, and video mode.",
      inputSchema: z.object({
        projectId: z.string().describe("Target project UUID"),
        prompt: z.string().describe("Generation prompt (English recommended)"),
        count: z.number().int().min(1).max(16).describe("Number of frames to generate (default 1)").optional(),
        autoMatting: z.boolean().describe("Auto-run background removal after generation").optional(),
        providerId: z.string().describe("Provider UUID (omit to use first configured provider)").optional(),
        model: z.string().describe("Model name (omit to use provider's first model)").optional(),
        size: z.string().describe("Output size (format varies by provider type)").optional(),
        mediaKind: z.enum(["image", "video"]).describe("image (default) or video mode").optional(),
        fps: z.number().int().min(1).max(60).describe("Video extraction fps (video mode)").optional(),
        referenceMaterialId: z.string().describe("Reference material UUID for image-to-image").optional(),
        referenceFrameId: z.string().describe("Reference frame UUID for image-to-image").optional(),
        references: z.array(z.object({
          kind: z.enum(["material", "frame"]),
          id: z.string(),
        })).max(10).describe("Ordered reference images; do not combine with legacy single-reference fields").optional(),
        flattenBackground: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe("Temporarily flatten transparent reference pixels onto this #RRGGBB color without changing source images").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const { projectId, prompt, count, autoMatting, providerId, model, size, mediaKind, fps, referenceMaterialId, referenceFrameId, references, flattenBackground } = args;
      const project = db.query("SELECT id FROM projects WHERE id = ?").get(projectId);
      if (!project) return err("项目不存在");
      const body = {
        projectId,
        prompt,
        count: count ?? 1,
        autoMatting: autoMatting ?? false,
        providerId,
        model,
        size,
        mediaKind,
        fps,
        referenceMaterialId,
        referenceFrameId,
        references,
        flattenBackground,
      };
      const ref = resolveReferencePaths(body);
      if (ref.error) return err(ref.error);
      const videoErr = checkVideoSupport(body);
      if (videoErr) return err(videoErr);
      const jobIds = createGenerationJobs(projectId, {
        prompt,
        count: body.count,
        autoMatting: body.autoMatting,
        target: { kind: "project", projectId },
        referencePaths: ref.referencePaths,
        flattenBackground,
        providerId,
        model,
        size,
        mediaKind,
        fps,
      });
      return ok({ jobId: jobIds[0], jobIds });
    }
  );

  server.registerTool(
    "generate_materials",
    {
      title: "Generate Materials",
      description:
        "Generate materials (not project frames) using an AI generation provider. Each requested image becomes an independently scheduled job; returns jobId (first job) and jobIds (all jobs). Materials go to the material library as each job completes. Same provider/reference options as generate_frames. Optional name sets the material name base (defaults to prompt prefix).",
      inputSchema: z.object({
        prompt: z.string().describe("Generation prompt (English recommended)"),
        count: z.number().int().min(1).max(16).describe("Number of materials to generate (default 1)").optional(),
        autoMatting: z.boolean().describe("Auto-run background removal after generation").optional(),
        name: z.string().describe("Material name base (defaults to prompt prefix)").optional(),
        providerId: z.string().describe("Provider UUID").optional(),
        model: z.string().describe("Model name").optional(),
        size: z.string().describe("Output size").optional(),
        mediaKind: z.enum(["image", "video"]).describe("image or video mode").optional(),
        fps: z.number().int().min(1).max(60).describe("Video extraction fps").optional(),
        referenceMaterialId: z.string().describe("Reference material UUID").optional(),
        referenceFrameId: z.string().describe("Reference frame UUID").optional(),
        references: z.array(z.object({
          kind: z.enum(["material", "frame"]),
          id: z.string(),
        })).max(10).describe("Ordered reference images; do not combine with legacy single-reference fields").optional(),
        flattenBackground: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe("Temporarily flatten transparent reference pixels onto this #RRGGBB color without changing source images").optional(),
        folderId: z.string().describe("Target folder UUID for generated materials").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const { prompt, count, autoMatting, name, providerId, model, size, mediaKind, fps, referenceMaterialId, referenceFrameId, references, flattenBackground, folderId } = args;
      const body = {
        prompt,
        count: count ?? 1,
        autoMatting: autoMatting ?? false,
        name,
        providerId,
        model,
        size,
        mediaKind,
        fps,
        referenceMaterialId,
        referenceFrameId,
        references,
        flattenBackground,
        folderId: folderId ?? null,
      };
      const ref = resolveReferencePaths(body);
      if (ref.error) return err(ref.error);
      const videoErr = checkVideoSupport(body);
      if (videoErr) return err(videoErr);
      const jobIds = createGenerationJobs("", {
        prompt,
        count: body.count,
        autoMatting: body.autoMatting,
        target: { kind: "materials" },
        name,
        referencePaths: ref.referencePaths,
        flattenBackground,
        providerId,
        model,
        size,
        mediaKind,
        fps,
        folderId: body.folderId,
      });
      return ok({ jobId: jobIds[0], jobIds });
    }
  );
}
