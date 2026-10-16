export const MODELS = [
  "claude-fable-5-1",
  "claude-haiku-5-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5-5",
  "deepseek-ocr",
  "deepseek-v3.2",
  "deepseek-v4-flash",
  "deepseek-v4-flash-external",
  "deepseek-v4-flash-vision-official",
  "deepseek-v4-pro",
  "deepseek-v4-pro-official",
  "glm-5",
  "glm-5.1",
  "glm-5.2",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.3-flash-internal",
  "gpt-4.1",
  "gpt-5.4",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
];

export function modelGroup(model: string) {
  if (model.startsWith("claude")) return "Claude";
  if (model.startsWith("deepseek")) return "DeepSeek";
  if (model.startsWith("glm")) return "GLM";
  if (model.startsWith("gpt")) return "GPT";
  return "其他";
}
