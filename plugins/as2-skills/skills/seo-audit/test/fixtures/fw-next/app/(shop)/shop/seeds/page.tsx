import type { Metadata } from "next";

// FW-NEXT-01: metadata without a title, and no title in the layouts above. The relative Open Graph image is silent
// for FW-NEXT-04 because the (shop) root layout sets metadataBase.
export const metadata: Metadata = {
	description: "Seed packets for shade and sun.",
	openGraph: { images: "/og/seeds.png" },
};

export default function Seeds() {
	return <h1>Seeds</h1>;
}
