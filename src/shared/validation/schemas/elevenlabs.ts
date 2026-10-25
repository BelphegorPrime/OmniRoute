// The ElevenLabs request schemas live with the engine (open-sse/shared) so the media-generation
// handler does not import from src/ (open-sse → src boundary ratchet, base-red #17219). The app
// routes keep importing from this path; it only re-exports the engine module.
export {
  elevenLabsSoundGenerationSchema,
  elevenLabsMusicSchema,
  elevenLabsMusicPlanSchema,
} from "@omniroute/open-sse/shared/elevenLabsSchemas";
