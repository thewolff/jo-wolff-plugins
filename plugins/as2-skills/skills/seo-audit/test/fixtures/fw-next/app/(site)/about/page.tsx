import type { Metadata } from "next";

// FW-NEXT-05: a title template exported from a page, where it has no effect.
export const metadata: Metadata = {
	title: { default: "About", template: "%s | About Fern Studio" },
	description: "Who we are and how we work.",
};

export default function About() {
	return <h1>About Fern Studio</h1>;
}
