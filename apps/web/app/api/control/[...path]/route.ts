import { NextRequest, NextResponse } from "next/server";

const CONTROL_URL = process.env.CONTROL_URL ?? "http://127.0.0.1:8787";
const SESSION_COOKIE =
  process.env.NODE_ENV === "production"
    ? "__Host-maker_session"
    : "maker_session";

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const route = path.join("/");
  const target = new URL(route, `${CONTROL_URL}/`);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  headers.set("accept", "application/json");
  const controlToken = process.env.CONTROL_TOKEN;
  if (controlToken) headers.set("x-control-token", controlToken);
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  if (session) headers.set("x-maker-session", session);

  const hasBody = !["GET", "HEAD"].includes(request.method);
  if (hasBody) headers.set("content-type", "application/json");

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    ...(hasBody ? { body: await request.text() } : {}),
    cache: "no-store",
  });
  const body = (await upstream.json()) as Record<string, unknown>;
  const responseBody = { ...body };

  const response = NextResponse.json(responseBody, {
    status: upstream.status,
    headers: { "cache-control": "no-store" },
  });

  if (
    upstream.ok &&
    route === "api/auth/verify" &&
    typeof body.sessionToken === "string" &&
    typeof body.expiresAt === "string"
  ) {
    delete responseBody.sessionToken;
    const cleanResponse = NextResponse.json(responseBody, {
      status: upstream.status,
      headers: { "cache-control": "no-store" },
    });
    cleanResponse.cookies.set(SESSION_COOKIE, body.sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      expires: new Date(body.expiresAt),
    });
    return cleanResponse;
  }

  if (
    route === "api/auth/logout" ||
    upstream.status === 401 ||
    (route === "api/auth/me" && upstream.status === 403)
  ) {
    response.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    });
  }
  return response;
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
