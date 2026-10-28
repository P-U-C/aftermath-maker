import { NextRequest, NextResponse } from "next/server";

const CONTROL_URL = process.env.CONTROL_URL ?? "http://127.0.0.1:8787";
const PUBLIC_ORIGIN = new URL(
  process.env.PUBLIC_ORIGIN ?? "http://localhost:8788",
).origin;
const SESSION_COOKIE =
  process.env.NODE_ENV === "production"
    ? "__Host-maker_session"
    : "maker_session";

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  if (
    path.length < 2 ||
    path[0] !== "api" ||
    path.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\"),
    )
  ) {
    return NextResponse.json(
      { error: "Unknown control route" },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  const route = path.join("/");
  const hasBody = !["GET", "HEAD"].includes(request.method);
  if (hasBody) {
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (
      origin !== PUBLIC_ORIGIN ||
      (fetchSite !== null && fetchSite !== "same-origin")
    ) {
      return NextResponse.json(
        { error: "Cross-origin control request rejected" },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    }
  }

  const target = new URL(CONTROL_URL);
  target.pathname = `/${path
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
  target.search = request.nextUrl.search;

  const headers = new Headers();
  headers.set("accept", "application/json");
  const controlToken = process.env.CONTROL_TOKEN;
  if (controlToken) headers.set("x-control-token", controlToken);
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  if (session) headers.set("x-maker-session", session);
  const clientIp =
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (clientIp && clientIp.length <= 64 && /^[0-9a-fA-F:.]+$/.test(clientIp)) {
    headers.set("x-maker-client-ip", clientIp);
  }

  if (hasBody) headers.set("content-type", "application/json");

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    ...(hasBody ? { body: await request.text() } : {}),
    cache: "no-store",
  });
  const upstreamPayload = await upstream.text();
  let body: Record<string, unknown>;
  try {
    body = upstreamPayload
      ? (JSON.parse(upstreamPayload) as Record<string, unknown>)
      : { error: `Control returned no response (${upstream.status})` };
  } catch {
    body = {
      error: `Control returned an invalid response (${upstream.status})`,
    };
  }
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
