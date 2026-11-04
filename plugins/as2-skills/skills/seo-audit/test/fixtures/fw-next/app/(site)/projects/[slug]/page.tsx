import type { Metadata } from "next";
import { LikeButton } from "../../../_components/like-button";

// Silent: generateMetadata returns a title, and the page is a Server Component that imports a client child.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
	const { slug } = await params;
	return { title: `Project ${slug}`, description: `The ${slug} garden, start to finish.` };
}

export default async function Project({ params }: { params: Promise<{ slug: string }> }) {
	const { slug } = await params;
	return (
		<article>
			<h1>{slug}</h1>
			<LikeButton />
		</article>
	);
}
