type ChatCompletionBody = Record<string, unknown>;

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function isAiGatewayConfigured(): boolean {
  return !!Deno.env.get("AI_GATEWAY_BASE_URL") && !!Deno.env.get("AI_GATEWAY_API_KEY");
}

export function aiTextModel(fallback: string): string {
  return Deno.env.get("AI_GATEWAY_TEXT_MODEL") || Deno.env.get("AI_GATEWAY_MODEL") || fallback;
}

export function aiImageModel(fallback: string): string {
  return Deno.env.get("AI_GATEWAY_IMAGE_MODEL") || Deno.env.get("AI_GATEWAY_MODEL") || fallback;
}

export async function fetchChatCompletion(body: ChatCompletionBody): Promise<Response> {
  const baseUrl = Deno.env.get("AI_GATEWAY_BASE_URL");
  const apiKey = Deno.env.get("AI_GATEWAY_API_KEY");

  if (!baseUrl || !apiKey) {
    throw new Error("AI_GATEWAY_BASE_URL and AI_GATEWAY_API_KEY must be configured");
  }

  return fetch(`${cleanBaseUrl(baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function generateTextFromPrompt(
  prompt: string,
  options: { model?: string; temperature?: number } = {},
): Promise<string> {
  const response = await fetchChatCompletion({
    model: options.model || aiTextModel("google/gemini-2.5-flash"),
    messages: [{ role: "user", content: prompt }],
    temperature: options.temperature ?? 0.3,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI Gateway error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}
