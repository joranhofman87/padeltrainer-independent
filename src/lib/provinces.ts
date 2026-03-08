// Province/Region data for SEO landing pages
// Maps province slugs to their display names and associated city slugs

export interface Province {
  slug: string;
  name: string;
  country: string;
  cities: string[]; // city slugs
}

// Dutch provinces
export const PROVINCES: Province[] = [
  { slug: 'noord-holland', name: 'Noord-Holland', country: 'NL', cities: ['amsterdam', 'haarlem', 'alkmaar', 'zaandam', 'hilversum', 'purmerend', 'heerhugowaard', 'hoorn', 'amstelveen', 'hoofddorp', 'velsen', 'castricum', 'heiloo', 'den-helder', 'enkhuizen', 'beverwijk'] },
  { slug: 'zuid-holland', name: 'Zuid-Holland', country: 'NL', cities: ['rotterdam', 'den-haag', 'the-hague', 'leiden', 'dordrecht', 'zoetermeer', 'delft', 'alphen-aan-den-rijn', 'schiedam', 'vlaardingen', 'gouda', 'leidschendam', 'rijswijk', 'capelle-aan-den-ijssel', 'spijkenisse', 'gorinchem', 'papendrecht', 'barendrecht', 'maassluis', 'voorburg', 'wassenaar', 'katwijk', 'voorhout', 'lisse', 'sassenheim', 'noordwijk', 'waddinxveen', 'nieuwerkerk-aan-den-ijssel'] },
  { slug: 'noord-brabant', name: 'Noord-Brabant', country: 'NL', cities: ['eindhoven', 'tilburg', 'breda', 'den-bosch', "'s-hertogenbosch", 'helmond', 'oss', 'roosendaal', 'bergen-op-zoom', 'waalwijk', 'veghel', 'uden', 'boxtel', 'dongen', 'best', 'valkenswaard', 'geldrop', 'eersel', 'oisterwijk', 'vught', 'nuenen'] },
  { slug: 'gelderland', name: 'Gelderland', country: 'NL', cities: ['arnhem', 'nijmegen', 'apeldoorn', 'ede', 'doetinchem', 'harderwijk', 'zutphen', 'zevenaar', 'barneveld', 'wageningen', 'tiel', 'culemborg', 'elburg', 'putten', 'ermelo', 'nunspeet', 'winterswijk', 'lichtenvoorde', 'groenlo'] },
  { slug: 'utrecht', name: 'Utrecht', country: 'NL', cities: ['utrecht', 'amersfoort', 'veenendaal', 'nieuwegein', 'zeist', 'houten', 'ijsselstein', 'woerden', 'bilthoven', 'soest', 'de-bilt', 'maarssen', 'driebergen', 'bunnik', 'vianen', 'baarn', 'leersum'] },
  { slug: 'overijssel', name: 'Overijssel', country: 'NL', cities: ['zwolle', 'enschede', 'deventer', 'hengelo', 'almelo', 'kampen', 'oldenzaal', 'raalte', 'hardenberg', 'ommen', 'rijssen', 'hellendoorn', 'steenwijk'] },
  { slug: 'limburg', name: 'Limburg', country: 'NL', cities: ['maastricht', 'venlo', 'heerlen', 'sittard', 'roermond', 'weert', 'kerkrade', 'geleen', 'brunssum', 'landgraaf', 'venray', 'tegelen'] },
  { slug: 'friesland', name: 'Friesland', country: 'NL', cities: ['leeuwarden', 'drachten', 'heerenveen', 'sneek', 'harlingen', 'franeker', 'joure'] },
  { slug: 'groningen', name: 'Groningen', country: 'NL', cities: ['groningen', 'veendam', 'stadskanaal', 'winschoten', 'hoogezand'] },
  { slug: 'drenthe', name: 'Drenthe', country: 'NL', cities: ['assen', 'emmen', 'hoogeveen', 'meppel', 'coevorden'] },
  { slug: 'flevoland', name: 'Flevoland', country: 'NL', cities: ['almere', 'lelystad', 'dronten', 'zeewolde'] },
  { slug: 'zeeland', name: 'Zeeland', country: 'NL', cities: ['middelburg', 'vlissingen', 'goes', 'terneuzen'] },
  // Belgian provinces
  { slug: 'antwerpen', name: 'Antwerpen', country: 'BE', cities: ['antwerpen', 'antwerp', 'mechelen', 'turnhout', 'lier', 'herentals', 'mol', 'geel'] },
  { slug: 'vlaams-brabant', name: 'Vlaams-Brabant', country: 'BE', cities: ['leuven', 'vilvoorde', 'halle', 'tienen', 'aarschot', 'diest'] },
  { slug: 'oost-vlaanderen', name: 'Oost-Vlaanderen', country: 'BE', cities: ['gent', 'ghent', 'aalst', 'sint-niklaas', 'dendermonde', 'lokeren', 'ronse'] },
  { slug: 'west-vlaanderen', name: 'West-Vlaanderen', country: 'BE', cities: ['brugge', 'bruges', 'kortrijk', 'oostende', 'roeselare', 'ieper'] },
  // Spanish regions
  { slug: 'cataluna', name: 'Cataluña', country: 'ES', cities: ['barcelona', 'tarragona', 'girona', 'lleida', 'sabadell', 'terrassa', 'badalona', 'mataro'] },
  { slug: 'comunidad-de-madrid', name: 'Comunidad de Madrid', country: 'ES', cities: ['madrid', 'alcobendas', 'las-rozas', 'pozuelo-de-alarcon', 'alcala-de-henares', 'getafe', 'leganes', 'mostoles'] },
  { slug: 'comunidad-valenciana', name: 'Comunidad Valenciana', country: 'ES', cities: ['valencia', 'alicante', 'elche', 'castellon', 'benidorm', 'torrevieja'] },
  { slug: 'andalucia', name: 'Andalucía', country: 'ES', cities: ['sevilla', 'malaga', 'granada', 'cordoba', 'cadiz', 'marbella', 'jerez', 'almeria'] },
  // German regions
  { slug: 'nordrhein-westfalen', name: 'Nordrhein-Westfalen', country: 'DE', cities: ['koln', 'cologne', 'dusseldorf', 'dortmund', 'essen', 'duisburg', 'bonn', 'munster', 'bielefeld', 'aachen', 'paderborn'] },
  { slug: 'bayern', name: 'Bayern', country: 'DE', cities: ['munchen', 'munich', 'nurnberg', 'augsburg', 'regensburg', 'wurzburg', 'ingolstadt'] },
  { slug: 'baden-wurttemberg', name: 'Baden-Württemberg', country: 'DE', cities: ['stuttgart', 'karlsruhe', 'mannheim', 'freiburg', 'heidelberg', 'ulm', 'heilbronn'] },
];

export function getProvinceBySlug(slug: string): Province | undefined {
  return PROVINCES.find(p => p.slug === slug);
}

export function getProvincesForCountry(countryCode: string): Province[] {
  return PROVINCES.filter(p => p.country === countryCode);
}

export function getAllProvinceSlugs(): string[] {
  return PROVINCES.map(p => p.slug);
}
