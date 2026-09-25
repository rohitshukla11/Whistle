import { redirect } from "next/navigation";

/**
 * There is no profile without an agent.
 *
 * The screen used to take `?name=`, which meant a bare `/profile` rendered an
 * empty form. A mandate now has a path of its own, so this is just the way back
 * to the list.
 */
export default function ProfileIndex() {
  redirect("/agents");
}
