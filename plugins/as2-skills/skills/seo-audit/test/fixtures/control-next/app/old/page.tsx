import { redirect } from "next/navigation";

// The old "new arrivals" URL moved to /new; Next's redirect answers 307 (FW-DNF-12).
export default function OldArrivals() {
	redirect("/new");
}
