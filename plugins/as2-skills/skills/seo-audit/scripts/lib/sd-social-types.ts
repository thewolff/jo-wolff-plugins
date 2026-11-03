// Structured-data type tables for the sd-social rule family (scripts/rules/sd-social.ts): the in-scope types of
// rules.md SD-GEN-06 and the properties Google lists as required for each, as tabulated in
// references/research/structured-data.md (SD-SW-01..03, SD-PRD-01, SD-REV-01/02, SD-VID-01), plus the supported
// `applicationCategory` values (SD-SW-04). Types are compared after stripping a schema.org prefix (normaliseType).
import type { Json } from "./jsonld.ts";

export type JsonObject = { [k: string]: Json };

export function isObject(v: Json | undefined): v is JsonObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// `https://schema.org/Product`, `http://schema.org/Product` and `schema:Product` all name `Product`.
export function normaliseType(t: string): string {
	return t.trim().replace(/^https?:\/\/schema\.org\//i, "").replace(/^schema:/i, "");
}

// An object that only points at another node (`{"@id": "…"}`): plan section 3 says `@id` references need not resolve
// in the same block, so a reference counts as the property being present.
export function isReference(v: Json | undefined): boolean {
	return isObject(v) && typeof v["@id"] === "string" && Object.keys(v).every((k) => k === "@id");
}

export function present(v: Json | undefined): boolean {
	if (v === undefined || v === null) return false;
	if (typeof v === "string") return v.trim() !== "";
	if (Array.isArray(v)) return v.some((x) => present(x));
	return true;
}

// The value as a list: a single value or the items of an array.
export function items(v: Json | undefined): Json[] {
	if (v === undefined) return [];
	return Array.isArray(v) ? v : [v];
}

export interface Requirement {
	property: string; // as named in the finding locator
	met: (node: JsonObject, nested: boolean) => boolean;
}

// Google's software-app doc names SoftwareApplication and the MobileApplication and WebApplication subtypes
// (research/structured-data.md SD-SW-08).
export const APP_TYPES: Record<string, true> = { SoftwareApplication: true, WebApplication: true, MobileApplication: true };

const APP: Requirement[] = [
	{ property: "name", met: (n) => present(n.name) },
	{
		property: "offers.price",
		met: (n) =>
			items(n.offers).some(
				(o) => isReference(o) || (isObject(o) && (present(o.price) || (isObject(o.priceSpecification) && present(o.priceSpecification.price)))),
			),
	},
];

// Required properties per in-scope type. Organization, WebSite, BreadcrumbList and Article have none listed (NF-07,
// SD-ORG-01, SD-ART-01); BreadcrumbList's two-item minimum is its own row (SD-BC-01).
export const REQUIRED: Record<string, Requirement[]> = {
	SoftwareApplication: APP,
	WebApplication: APP,
	MobileApplication: APP,
	Product: [
		{ property: "name", met: (n) => present(n.name) },
		{ property: "review|aggregateRating|offers", met: (n) => present(n.review) || present(n.aggregateRating) || present(n.offers) },
	],
	Review: [
		{ property: "author", met: (n) => present(n.author) },
		{ property: "itemReviewed", met: (n, nested) => nested || present(n.itemReviewed) },
		{ property: "reviewRating.ratingValue", met: (n) => items(n.reviewRating).some((r) => isReference(r) || (isObject(r) && present(r.ratingValue))) },
	],
	AggregateRating: [
		{ property: "itemReviewed", met: (n, nested) => nested || present(n.itemReviewed) },
		{ property: "ratingValue", met: (n) => present(n.ratingValue) },
		{ property: "ratingCount|reviewCount", met: (n) => present(n.ratingCount) || present(n.reviewCount) },
	],
	VideoObject: [
		{ property: "name", met: (n) => present(n.name) },
		{ property: "thumbnailUrl", met: (n) => present(n.thumbnailUrl) },
		{ property: "uploadDate", met: (n) => present(n.uploadDate) },
	],
};

// research/structured-data.md SD-SW-04.
export const APP_CATEGORIES: Record<string, true> = Object.fromEntries(
	[
		"GameApplication",
		"SocialNetworkingApplication",
		"TravelApplication",
		"ShoppingApplication",
		"SportsApplication",
		"LifestyleApplication",
		"BusinessApplication",
		"DesignApplication",
		"DeveloperApplication",
		"DriverApplication",
		"EducationalApplication",
		"HealthApplication",
		"FinanceApplication",
		"SecurityApplication",
		"BrowserApplication",
		"CommunicationApplication",
		"DesktopEnhancementApplication",
		"EntertainmentApplication",
		"MultimediaApplication",
		"HomeApplication",
		"UtilitiesApplication",
		"ReferenceApplication",
	].map((c) => [c, true] as const),
);

// `Organization` and every schema.org type below it (subTypeOf closure of
// https://schema.org/version/latest/schemaorg-current-https-types.csv, fetched 2026-10-12): rules.md SD-REV-08 names
// "an `Organization` (or subtype such as `LocalBusiness`)".
export const ORGANIZATION_TYPES: Record<string, true> = Object.fromEntries(
	[
		"AccountingService", "AdultEntertainment", "Airline", "AmusementPark", "AnimalShelter", "ArchiveOrganization",
		"ArtGallery", "Attorney", "Audiology", "AutoBodyShop", "AutoDealer", "AutoPartsStore", "AutoRental", "AutoRepair",
		"AutoWash", "AutomatedTeller", "AutomotiveBusiness", "Bakery", "BankOrCreditUnion", "BarOrPub", "BeautySalon",
		"BedAndBreakfast", "BikeStore", "BookStore", "BowlingAlley", "Brewery", "CafeOrCoffeeShop", "Campground", "Casino",
		"ChildCare", "ClothingStore", "CollegeOrUniversity", "ComedyClub", "CommunityHealth", "ComputerStore", "Consortium",
		"ConvenienceStore", "Cooperative", "Corporation", "CovidTestingFacility", "DanceGroup", "DaySpa", "Dentist",
		"DepartmentStore", "Dermatology", "DiagnosticLab", "DietNutrition", "Distillery", "DryCleaningOrLaundry",
		"EducationalOrganization", "Electrician", "ElectronicsStore", "ElementarySchool", "Emergency", "EmergencyService",
		"EmploymentAgency", "EntertainmentBusiness", "ExerciseGym", "FastFoodRestaurant", "FinancialService", "FireStation",
		"Florist", "FoodEstablishment", "FundingAgency", "FundingScheme", "FurnitureStore", "GardenStore", "GasStation",
		"GeneralContractor", "Geriatric", "GolfCourse", "GovernmentOffice", "GovernmentOrganization", "GroceryStore",
		"Gynecologic", "HVACBusiness", "HairSalon", "HardwareStore", "HealthAndBeautyBusiness", "HealthClub", "HighSchool",
		"HobbyShop", "HomeAndConstructionBusiness", "HomeGoodsStore", "Hospital", "Hostel", "Hotel", "HousePainter",
		"IceCreamShop", "IndividualPhysician", "InsuranceAgency", "InternetCafe", "JewelryStore", "LegalService", "Library",
		"LibrarySystem", "LiquorStore", "LocalBusiness", "Locksmith", "LodgingBusiness", "MedicalBusiness", "MedicalClinic",
		"MedicalOrganization", "MensClothingStore", "MiddleSchool", "Midwifery", "MobilePhoneStore", "Motel",
		"MotorcycleDealer", "MotorcycleRepair", "MovieRentalStore", "MovieTheater", "MovingCompany", "MusicGroup",
		"MusicStore", "NGO", "NailSalon", "NewsMediaOrganization", "NightClub", "Notary", "Nursing", "Obstetric",
		"OfficeEquipmentStore", "Oncologic", "OnlineBusiness", "OnlineMarketplace", "OnlineStore", "Ophthalmology",
		"Optician", "Optometric", "Organization", "Otolaryngologic", "OutletStore", "PawnShop", "Pediatric",
		"PerformingGroup", "PetStore", "Pharmacy", "Physician", "PhysiciansOffice", "Physiotherapy", "PlasticSurgery",
		"Plumber", "Podiatric", "PoliceStation", "PoliticalParty", "PostOffice", "Preschool", "PrimaryCare",
		"ProfessionalService", "Project", "Psychiatric", "PublicHealth", "PublicSwimmingPool", "RadioStation",
		"RealEstateAgent", "RecyclingCenter", "ResearchOrganization", "ResearchProject", "Resort", "Restaurant",
		"RoofingContractor", "School", "SearchRescueOrganization", "SelfStorage", "ShoeStore", "ShoppingCenter", "SkiResort",
		"SportingGoodsStore", "SportsActivityLocation", "SportsClub", "SportsOrganization", "SportsTeam", "StadiumOrArena",
		"Store", "TattooParlor", "TelevisionStation", "TennisComplex", "TheaterGroup", "TireShop", "TouristInformationCenter",
		"ToyStore", "TravelAgency", "VacationRental", "VeterinaryCare", "WholesaleStore", "Winery", "WorkersUnion",
	].map((t) => [t, true] as const),
);

// Article types named by Google's Article doc (research/structured-data.md SD-ART-01).
export const ARTICLE_TYPES: Record<string, true> = { Article: true, NewsArticle: true, BlogPosting: true };

// The in-scope types of SD-GEN-06 (SD-GEN-11 and SD-JLD-06 read the same scope).
export function inScope(types: string[]): boolean {
	return types.some(
		(t) =>
			REQUIRED[t] !== undefined ||
			ORGANIZATION_TYPES[t] ||
			ARTICLE_TYPES[t] ||
			t === "Offer" ||
			t === "AggregateOffer" ||
			t === "WebSite" ||
			t === "BreadcrumbList",
	);
}
