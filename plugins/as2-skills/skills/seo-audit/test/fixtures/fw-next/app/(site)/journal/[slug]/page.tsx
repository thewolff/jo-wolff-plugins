import type { Metadata } from "next";

// FW-NEXT-01: one file exports both `metadata` and `generateMetadata`.
export const metadata: Metadata = { description: "Notes from the studio." };

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
	const { slug } = await params;
	return { title: `Journal: ${slug}` };
}

export default async function Entry({ params }: { params: Promise<{ slug: string }> }) {
	const { slug } = await params;
	return <h1>{slug}</h1>;
}
