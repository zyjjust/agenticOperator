import { redirect } from "next/navigation";

export default function HomePage() {
  // Was /fleet (Direction A demo). /overview is the actual home page now —
  // system at a glance, the proper entry surface for any operator.
  redirect("/overview");
}
