import type { Metadata } from "next";

export const metadata: Metadata = {
	title: "New this month",
	description: "The books that arrived at Quayside Books this month, from local history to sea fiction.",
};

export default function NewThisMonth() {
	return (
		<main>
			<h1>New this month</h1>
			<p>A new history of the harbour, two sea novels and a box of old charts.</p>
		</main>
	);
}
