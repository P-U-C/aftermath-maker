import { NextRequest, NextResponse } from "next/server";

const CONTROL_URL = process.env.CONTROL_URL ?? "http://127.0.0.1:8787";

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const target = new URL(path.join("/"), `${CONTROL_URL}/`);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  headers.set("accept", "application/json");
  const token = process.env.CONTROL_TOKEN;
  if (token) headers.set("x-control-token", token);

  const hasBody = !["GET", "HEAD"].includes(request.method);
  if (hasBody) headers.set("content-type", "application/json");

  const response = await fetch(target, {
    method: request.method,
    headers,
    ...(hasBody ? { body: await request.text() } : {}),
    cache: "no-store",
  });
  const text = await response.text();

  return new NextResponse(text, {
    status: response.status,
    headers: {
      "content-type":
        response.headers.get("content-type") ?? "application/json",
    },
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
