// Lightweight, unauthenticated health check for Railway deploy health probes.
// Does not touch the database so a DB blip doesn't fail the container check.
export const loader = () => new Response("ok", { status: 200 });
