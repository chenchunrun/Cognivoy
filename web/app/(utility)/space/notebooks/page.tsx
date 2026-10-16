import { redirect } from "next/navigation";

/** Notebooks live at /notebook (built by another area); keep the Space URL working. */
export default function SpaceNotebooksPage() {
  redirect("/notebook");
}
