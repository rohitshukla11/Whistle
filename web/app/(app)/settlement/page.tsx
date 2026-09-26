import { redirect } from "next/navigation";

/**
 * Old route, kept so links and the demo script do not break. The fixture list
 * is the app's home now, and a fixture lives at `/fixtures/<id>`; `?f=<id>`
 * (the old switcher's query) goes straight to that fixture.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const { f } = await searchParams;
  redirect(f && /^\d+$/.test(f) ? `/fixtures/${f}` : "/fixtures");
}
