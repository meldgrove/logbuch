import { getAuth } from "@/lib/auth/auth";

// Better Auth endpoints, including the Keycloak callback
// /api/auth/callback/keycloak.
export function GET(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export function POST(request: Request): Promise<Response> {
  return getAuth().handler(request);
}
