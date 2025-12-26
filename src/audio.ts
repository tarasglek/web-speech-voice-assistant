// deno-lint-ignore-file no-explicit-any
export function binary2base64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

export async function getChatCompletion(
  input: object,
  token: string,
  baseUrl: string = "https://openrouter.ai/api/v1",
): Promise<any> {
  const response = await fetch(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `API request failed with status ${response.status}: ${errorBody}`,
    );
  }

  return response.json();
}
