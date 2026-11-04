// Code lists for hreflang values (rules.md INT-004): "Only language codes listed in ISO 639-1 and region codes listed in
// ISO 3166-1 Alpha 2 are supported". ISO 639-1 is the 183 current two-letter codes (the withdrawn in, iw, ji, jw, mo,
// sh and bh are not listed); ISO 3166-1 alpha-2 is the 249 officially assigned codes (the exceptionally reserved EU,
// UN and UK, the transitional and withdrawn codes, and user-assigned codes such as XK are not listed).

const ISO_639_1_LIST =
	"aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu";

const ISO_3166_1_ALPHA2_LIST =
	"AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";

export const ISO_639_1: Record<string, true> = Object.fromEntries(ISO_639_1_LIST.split(" ").map((c) => [c, true] as const));
export const ISO_3166_1_ALPHA2: Record<string, true> = Object.fromEntries(ISO_3166_1_ALPHA2_LIST.split(" ").map((c) => [c, true] as const));

// Region codes Google names as having no effect in hreflang.
const NO_EFFECT_REGIONS: Record<string, true> = { EU: true, UN: true, UK: true };

// Why an hreflang value is not supported, or null when it is. A four-letter ISO 15924 script subtag between language
// and region (zh-Hant-TW) is passed through: the cited source neither lists nor forbids it.
export function hreflangProblem(value: string): string | null {
	const v = value.trim();
	if (v.toLowerCase() === "x-default") return null;
	const parts = v.split(/[-_]/);
	const lang = (parts[0] ?? "").toLowerCase();
	const rest = parts.slice(1);
	if (rest[0] && /^[A-Za-z]{4}$/.test(rest[0])) rest.shift();
	const region = rest[0]?.toUpperCase();
	if (!ISO_639_1[lang]) {
		if (parts.length === 1 && ISO_3166_1_ALPHA2[lang.toUpperCase()]) return `"${v}" is a region alone; a language code is required`;
		return `"${v}": "${parts[0] ?? ""}" is not an ISO 639-1 language code`;
	}
	if (rest.length > 1) return `"${v}" has more subtags than language-region`;
	if (region === undefined) return null;
	if (NO_EFFECT_REGIONS[region]) return `"${v}": ${region} is not an ISO 3166-1 alpha-2 region; it has no effect in hreflang`;
	if (!ISO_3166_1_ALPHA2[region]) return `"${v}": "${rest[0] ?? ""}" is not an ISO 3166-1 alpha-2 region code`;
	return null;
}
