import type { Metadata } from "next";

// FW-NEXT-04: metadataBase names a preview deployment, not the production host.
export const metadata: Metadata = {
	metadataBase: new URL("https://fern-studio-git-shop-preview-fern.vercel.app"),
	description: "Seeds, tools and planting plans from Fern Studio.",
};

export default function ShopLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
