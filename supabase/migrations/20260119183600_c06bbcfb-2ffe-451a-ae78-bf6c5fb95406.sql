-- Create locations table for padel venues
CREATE TABLE public.locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  street_address TEXT,
  postal_code TEXT,
  city TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'NL',
  website_url TEXT,
  slug TEXT UNIQUE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create indexes for efficient queries
CREATE INDEX idx_locations_city ON public.locations(city);
CREATE INDEX idx_locations_country ON public.locations(country);
CREATE INDEX idx_locations_slug ON public.locations(slug);
CREATE INDEX idx_locations_active ON public.locations(is_active);

-- Enable RLS
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

-- Anyone can view active locations
CREATE POLICY "Anyone can view active locations"
ON public.locations FOR SELECT
USING (is_active = true);

-- Admins can view all locations (including inactive)
CREATE POLICY "Admins can view all locations"
ON public.locations FOR SELECT
USING (public.is_admin(auth.uid()));

-- Admins can insert locations
CREATE POLICY "Admins can insert locations"
ON public.locations FOR INSERT
WITH CHECK (public.is_admin(auth.uid()));

-- Admins can update locations
CREATE POLICY "Admins can update locations"
ON public.locations FOR UPDATE
USING (public.is_admin(auth.uid()));

-- Admins can delete locations
CREATE POLICY "Admins can delete locations"
ON public.locations FOR DELETE
USING (public.is_admin(auth.uid()));

-- Create trainer_locations junction table
CREATE TABLE public.trainer_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(trainer_id, location_id)
);

-- Indexes
CREATE INDEX idx_trainer_locations_trainer ON public.trainer_locations(trainer_id);
CREATE INDEX idx_trainer_locations_location ON public.trainer_locations(location_id);

-- Enable RLS
ALTER TABLE public.trainer_locations ENABLE ROW LEVEL SECURITY;

-- Anyone can view trainer locations (public for discovery)
CREATE POLICY "Anyone can view trainer locations"
ON public.trainer_locations FOR SELECT
USING (true);

-- Trainers can insert their own locations
CREATE POLICY "Trainers can insert own locations"
ON public.trainer_locations FOR INSERT
WITH CHECK (trainer_id IN (
  SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
));

-- Trainers can update their own locations
CREATE POLICY "Trainers can update own locations"
ON public.trainer_locations FOR UPDATE
USING (trainer_id IN (
  SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
));

-- Trainers can delete their own locations
CREATE POLICY "Trainers can delete own locations"
ON public.trainer_locations FOR DELETE
USING (trainer_id IN (
  SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
));

-- Create player_locations junction table (PRIVATE - only players can see their own)
CREATE TABLE public.player_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  is_preferred BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(profile_id, location_id)
);

-- Indexes
CREATE INDEX idx_player_locations_profile ON public.player_locations(profile_id);
CREATE INDEX idx_player_locations_location ON public.player_locations(location_id);

-- Enable RLS
ALTER TABLE public.player_locations ENABLE ROW LEVEL SECURITY;

-- Players can ONLY view their own location preferences (PRIVATE from trainers)
CREATE POLICY "Players can view own locations"
ON public.player_locations FOR SELECT
USING (profile_id IN (
  SELECT id FROM public.profiles WHERE user_id = auth.uid()
));

-- Players can insert their own locations
CREATE POLICY "Players can insert own locations"
ON public.player_locations FOR INSERT
WITH CHECK (profile_id IN (
  SELECT id FROM public.profiles WHERE user_id = auth.uid()
));

-- Players can update their own locations
CREATE POLICY "Players can update own locations"
ON public.player_locations FOR UPDATE
USING (profile_id IN (
  SELECT id FROM public.profiles WHERE user_id = auth.uid()
));

-- Players can delete their own locations
CREATE POLICY "Players can delete own locations"
ON public.player_locations FOR DELETE
USING (profile_id IN (
  SELECT id FROM public.profiles WHERE user_id = auth.uid()
));

-- Trigger for updated_at on locations
CREATE TRIGGER update_locations_updated_at
BEFORE UPDATE ON public.locations
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Helper function to generate slug from name and city
CREATE OR REPLACE FUNCTION public.generate_location_slug(name TEXT, city TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN lower(
    regexp_replace(
      regexp_replace(
        unaccent(name || '-' || city),
        '[^a-zA-Z0-9\-]', '-', 'g'
      ),
      '-+', '-', 'g'
    )
  );
END;
$$;

-- Insert Dutch padel locations from CSV data
INSERT INTO public.locations (name, street_address, postal_code, city, country, website_url, slug) VALUES
('''t Root', 'Lienderweg 55', '5721 CJ', 'Asten', 'NL', 'http://www.tvroot.nl/', 't-root-asten'),
('''t Schilt', 'John F. Kennedylaan 114', '3931 XM', 'Woudenberg', 'NL', 'http://www.tvtschilt.nl/', 't-schilt-woudenberg'),
('A.S.T.P.V. Chip & Charge', 'Radioweg 80', '1098 NJ', 'Amsterdam', 'NL', 'http://www.chipencharge.nl/', 'chip-charge-amsterdam'),
('A.T.C. Dronten', 'Educalaan 20', '8251 GC', 'Dronten', 'NL', 'http://www.atc-dronten.nl/', 'atc-dronten'),
('A.T.P.C. de Groene Kamer', 'Daam Fockemalaan 2', '6815 DL', 'Arnhem', 'NL', 'http://www.atcdegroenekamer.nl/', 'groene-kamer-arnhem'),
('A.T.V. De Hertenkamp', 'Hertenkamp 9', '9401 HL', 'Assen', 'NL', 'http://www.atvdehertenkamp.nl/', 'hertenkamp-assen'),
('Abcouder L.T.C.', 'Zuster Claassenhof 15', '1391 BL', 'Abcoude', 'NL', 'http://www.altctennis.nl/', 'abcouder-ltc-abcoude'),
('Alblasserdamse T.V.', 'Bas Verhoevenweg 9', '2952 BV', 'Alblasserdam', 'NL', 'http://www.tennisvereniging-atv.nl/', 'alblasserdamse-tv'),
('Allied Sports Club', 'Smidsstraat 6-C', '8601 WB', 'Sneek', 'NL', 'https://allied-sports.nl/nl', 'allied-sports-sneek'),
('ALTV Zoetermeer', 'Dr. J.W. Paltelaan 111', '2712 PT', 'Zoetermeer', 'NL', 'http://www.altvzoetermeer.nl/', 'altv-zoetermeer'),
('Amerongse T.V.', 'Burgwal 2', '3958 ER', 'Amerongen', 'NL', 'http://www.amerongsetennisvereniging.nl/', 'amerongse-tv'),
('Amigo''s de Padel', 'Boschstraat 23', '6442 PB', 'Brunssum', 'NL', 'http://www.amigosdepadel.nl/', 'amigos-de-padel-brunssum'),
('Apart Hotel Delden', 'Sportlaan 7', '7491 DG', 'Delden', 'NL', 'https://www.aparthoteldelden.nl/', 'apart-hotel-delden'),
('Apeldoorn Padel', 'Vlijtseweg 150', '7317 AK', 'Apeldoorn', 'NL', 'http://apeldoornpadel.nl/', 'apeldoorn-padel'),
('Arenal Nederland BV (Kerkrade)', 'Tunnelweg 86', '6468 EK', 'Kerkrade', 'NL', 'https://kerkrade.arenal.nl/', 'arenal-kerkrade'),
('Arendse health club', 'Doelstraat 16', '5101 PA', 'Dongen', 'NL', 'https://www.arendse.nl/', 'arendse-dongen'),
('ATC Veenhorst', 'Veenelandenweg 3', '7608 HD', 'Almelo', 'NL', 'http://www.atc-veenhorst.nl/', 'atc-veenhorst-almelo'),
('B. Amsterdam padel', 'Johan Huizingalaan 763-A', '1066 VH', 'Amsterdam', 'NL', 'https://b-amsterdam.com/padel-courts/', 'b-amsterdam-padel'),
('B.R.Z.', 'Bloote Weg 9', '6191 EM', 'Beek', 'NL', 'http://www.brztennis.nl/', 'brz-beek'),
('B.T.V. E ''68', 'Geuzenpark 1', '3237 KN', 'Vierpolders', 'NL', 'http://www.btve68.nl/', 'btv-e68-vierpolders'),
('Baarnse Lawn Tennis Club', 'Bosbadlaan 3', '3744 KD', 'Baarn', 'NL', 'http://www.bltcbaarn.nl/', 'bltc-baarn'),
('Bakkershaag', 'Hogenkampseweg 45', '6871 JK', 'Renkum', 'NL', 'http://www.rtvbakkershaag.nl/', 'bakkershaag-renkum'),
('BAS Tennis & Padel', 'Sportlaan 36', '8256 CE', 'Biddinghuizen', 'NL', 'http://www.bastennis.nl/', 'bas-tennis-biddinghuizen'),
('Bastion Baselaar', 'Meester Vriensstraat 1', '5246 JS', 'Rosmalen', 'NL', 'http://www.bastionbaselaar.nl/', 'bastion-baselaar-rosmalen'),
('Be Fair', 'Sniepweg 13', '2742 AR', 'Waddinxveen', 'NL', 'http://www.befairtennis.nl/', 'be-fair-waddinxveen'),
('Benthuizer T.C.', 'de Dam 7', '2731 CE', 'Benthuizen', 'NL', 'https://www.benthuizertennis.club/', 'benthuizer-tc'),
('Bergenshuizen', 'Kraaiengatweg 6', '5262 LK', 'Vught', 'NL', 'http://www.tvb.nl/', 'bergenshuizen-vught'),
('Bildtse T.C. B.T.C.', 'Hartman Sannesstraat 11', '9076 EB', 'St.-Annaparochie', 'NL', 'http://www.bildtsetc.nl/', 'bildtse-tc'),
('Binck Padel Den Haag', 'Zonweg 23', '2516 AK', 'Den Haag', 'NL', 'http://www.binckpadel.nl/', 'binck-padel-den-haag'),
('BPV Push', 'Nieuwe Inslag 97', '4817 GN', 'Breda', 'NL', 'http://www.pushpadel.nl/', 'bpv-push-breda'),
('btv De Geeren', 'De Geerenweg 14', '3741 RS', 'Baarn', 'NL', 'http://www.btvdegeeren.nl/', 'btv-de-geeren-baarn'),
('C.O.V. Desto, afd. tennis', 'Componistenlaan 1', '3451 SX', 'Vleuten', 'NL', 'https://desto-utrecht.nl/', 'cov-desto-vleuten'),
('Casa de Padel Deurne', 'Energiestraat 1', '5753 RN', 'Deurne', 'NL', 'https://www.casadepadel.io/', 'casa-de-padel-deurne'),
('Club Pellikaan Maastricht', 'Dousbergweg 4', '6216 GC', 'Maastricht', 'NL', 'http://www.clubpellikaan.nl/', 'club-pellikaan-maastricht'),
('D.L.T.C. - Drachten', 'Folgeren 10', '9207 AB', 'Drachten', 'NL', 'http://www.dltc.nl/', 'dltc-drachten'),
('D.L.T.C. Gerner', 'Haersolteweg 16', '7722 SE', 'Dalfsen', 'NL', 'http://www.dltc-gerner.nl/', 'dltc-gerner-dalfsen'),
('D.T.V. de Donkelaar', 'Tennispad 2', '5275 AH', 'Den Dungen', 'NL', 'http://www.dedonkelaar.nl/', 'dtv-donkelaar-den-dungen'),
('De Bocht', 'Sprundelseweg 34-A', '4715 RC', 'Rucphen', 'NL', 'http://www.tvdebocht.nl/', 'de-bocht-rucphen'),
('De Broekhoek', 'Kerkweg 18', '5384 NL', 'Heesch', 'NL', 'http://www.tvdebroekhoek.nl/', 'de-broekhoek-heesch'),
('De Gouwe', 'Donkerstraat 44', '4847 EJ', 'Teteringen', 'NL', 'http://www.teteringsetennisvereniging.nl/', 'de-gouwe-teteringen'),
('De Gouwe Smash', 'Kanaaldijk 9', '2741 PA', 'Waddinxveen', 'NL', 'http://www.degouwesmash.nl/', 'de-gouwe-smash-waddinxveen'),
('De Hakkelaars', 'Naarderstraatweg 4', '1399 VR', 'Muiderberg', 'NL', 'http://www.hakkelaars.com/', 'de-hakkelaars-muiderberg'),
('De Hartel Tennis en Padel', 'Voorweg 2', '3202 LC', 'Spijkenisse', 'NL', 'http://www.ltvdehartel.nl/', 'de-hartel-spijkenisse'),
('De Hellekens', 'Burg. Van Woenseldreef 17', '5527 JN', 'Hapert', 'NL', 'http://www.dehellekens.nl/', 'de-hellekens-hapert'),
('De Kienehoef', 'Bremhorst 2-A', '5491 LR', 'Sint-Oedenrode', 'NL', 'https://www.tpvdekienehoef.nl/', 'de-kienehoef-sint-oedenrode'),
('De Marsch', 'Hooiweg 196-A', '9765 EM', 'Paterswolde', 'NL', 'http://www.tvdemarsch.nl/', 'de-marsch-paterswolde'),
('De Molenwiek', 'Langerakseweg 2', '5306 TC', 'Brakel', 'NL', 'http://www.tvdemolenwiek.nl/', 'de-molenwiek-brakel'),
('De Oorsprong', 'Alde Weteringweg 6', '6573 AZ', 'Beek', 'NL', 'http://www.tvdeoorsprong.nl/', 'de-oorsprong-beek'),
('De Oude Eik', 'Ammonslaantje 37', '2241 BR', 'Wassenaar', 'NL', 'http://www.deoudeeik.nl/', 'de-oude-eik-wassenaar'),
('De Peppelieren', 'Hogenbergseweg 50', '5298 TT', 'Liempde', 'NL', 'http://www.peppelieren.nl/', 'de-peppelieren-liempde'),
('De Raam Lieshout', 'Provinciale Weg 22', '5737 GH', 'Lieshout', 'NL', 'http://www.tvderaam.nl/', 'de-raam-lieshout'),
('De Riet Indoor Entertainment', 'Weltersweide 22', '5961 EJ', 'Horst', 'NL', 'http://www.deriet.nl/', 'de-riet-horst'),
('De Sluipers', 'Oud Reeuwijkseweg 3', '2811 KB', 'Reeuwijk', 'NL', 'http://www.sluipers.nl/', 'de-sluipers-reeuwijk'),
('De Sprenk', 'Geneneind 6-A', '5761 RH', 'Bakel', 'NL', 'http://www.desprenkbakel.nl/', 'de-sprenk-bakel'),
('De Stouwe Indoor Tennis & Padel', 'Handelsweg 10', '7641 AC', 'Wierden', 'NL', 'http://www.sportcentrumdestouwe.nl/', 'de-stouwe-wierden'),
('De Stuw', 'Kolk 17', '4271 LB', 'Dussen', 'NL', 'http://www.tvdestuw.nl/', 'de-stuw-dussen'),
('De Tol', 'Boslaan 1', '6617 KM', 'Bergharen', 'NL', 'http://www.tvdetol.nl/', 'de-tol-bergharen'),
('De Toren', 'Valkenseweg 161', '6866 AW', 'Heelsum', 'NL', 'http://www.tvdetoren.nl/', 'de-toren-heelsum'),
('De Vallei', 'Valkensteinstraat 4', '4181 GS', 'Waardenburg', 'NL', 'http://www.devallei-tennis.nl/', 'de-vallei-waardenburg'),
('De Vijf Eiken', 'Eikenlaan 65', '3762 EA', 'Soest', 'NL', 'http://www.devijfeiken.nl/', 'de-vijf-eiken-soest'),
('De Vliert', 'Schuurhoek 42', '4927 NT', 'Hooge Zwaluwe', 'NL', 'http://www.devliert.nl/', 'de-vliert-hooge-zwaluwe'),
('De Warande', 'Kievitstraat 4', '5212 VJ', 's-Hertogenbosch', 'NL', 'http://www.warande.nl/', 'de-warande-s-hertogenbosch'),
('De Weere', 'Middenweg 2', '1459 EP', 'De Weere', 'NL', 'http://www.tvdeweere.nl/', 'de-weere'),
('De Witte Molen', 'Kloosterdijk 24', '9665 KK', 'Oude Pekela', 'NL', 'http://www.dewittemolen.nl/', 'de-witte-molen-oude-pekela'),
('De Witte Raaf', 'Stationsstraat 7', '4631 PS', 'Hoogerheide', 'NL', 'http://www.dewitteraaf.nl/', 'de-witte-raaf-hoogerheide'),
('De Zandhoek', 'Hevesingel 10', '6641 VD', 'Beuningen', 'NL', 'http://www.dezandhoek.nl/', 'de-zandhoek-beuningen'),
('De Zeeuwse Kust', 'Molenweg 69-A', '4354 LA', 'Vrouwenpolder', 'NL', 'http://www.dezeeuwsekust.nl/', 'de-zeeuwse-kust-vrouwenpolder'),
('DEM-Beverwijk', 'Meerweg 32', '1942 LM', 'Beverwijk', 'NL', 'http://www.tcdembeverwijk.nl/', 'dem-beverwijk'),
('Den Hoorn', 'Piet Heinlaan 2', '2638 EE', 'Schipluiden', 'NL', 'http://www.tvdenhoorn.nl/', 'den-hoorn-schipluiden'),
('Denekamp', 'Nordhornsestraat 100', '7591 NJ', 'Denekamp', 'NL', 'http://www.tvdenekamp.nl/', 'denekamp'),
('DHC', 'Waalreseweg 26', '5582 HR', 'Waalre', 'NL', 'http://www.dhc-waalre.nl/', 'dhc-waalre'),
('Dijkhuizen Aalten', 'Dijkstraat 65', '7121 HC', 'Aalten', 'NL', 'http://www.dijkhuizenaalten.nl/', 'dijkhuizen-aalten'),
('Diligentia', 'Vijfsprongweg 30', '3911 ST', 'Rhenen', 'NL', 'http://www.diligentia-rhenen.nl/', 'diligentia-rhenen'),
('Doesburg Tennis Club', 'Oranjesingel 32', '6981 HK', 'Doesburg', 'NL', 'http://www.doesburgtennisclub.nl/', 'doesburg-tennis-club'),
('Donkse', 'Groenewegje 7', '4159 LR', 'Acquoy', 'NL', 'http://www.tcdonkse.nl/', 'donkse-acquoy'),
('Dordtsche L.T.C.', 'Laan der Verenigde Naties 2', '3317 NX', 'Dordrecht', 'NL', 'http://www.dltc.nl/', 'dltc-dordrecht'),
('Elden', 'Huissensestraat 193', '6843 CP', 'Arnhem', 'NL', 'http://www.tvelden.nl/', 'elden-arnhem'),
('Elinkwijk', 'Elinkwijk 2', '3544 PM', 'Utrecht', 'NL', 'http://www.elinkwijktennis.nl/', 'elinkwijk-utrecht'),
('Emmen', 'Kerspellaan 10', '7824 JH', 'Emmen', 'NL', 'http://www.tvemmen.nl/', 'emmen'),
('ETV De Kievit', 'Hofweg 1', '3132 GZ', 'Vlaardingen', 'NL', 'http://www.etvdekievit.nl/', 'etv-de-kievit-vlaardingen'),
('Exloo', 'Valtherweg 2', '7875 TA', 'Exloo', 'NL', 'http://www.tvexloo.nl/', 'exloo'),
('FC Twente padel', 'De Grolsch Veste 7', '7532 KR', 'Enschede', 'NL', 'https://www.fctwente.nl/', 'fc-twente-padel-enschede'),
('Fjord Padel', 'Zuiderlaan 8', '8271 EL', 'IJsselmuiden', 'NL', 'https://www.fjordpadel.nl/', 'fjord-padel-ijsselmuiden'),
('Fleringen', 'Eschweg 12', '7642 RE', 'Fleringen', 'NL', 'http://www.tvfleringen.nl/', 'fleringen'),
('Forum Sport', 'Amstelveenseweg 500', '1081 KL', 'Amsterdam', 'NL', 'http://www.forumsport.nl/', 'forum-sport-amsterdam'),
('Franeker', 'Hertog van Saxenlaan 78', '8802 PT', 'Franeker', 'NL', 'http://www.tvfraneker.nl/', 'franeker'),
('Gaanderen', 'Doetinchemseweg 64', '7011 GK', 'Gaanderen', 'NL', 'http://www.tvgaanderen.nl/', 'gaanderen'),
('Game On Padel', 'Pottenbakkerstraat 12', '7271 AV', 'Borculo', 'NL', 'https://www.gameonpadel.nl/', 'game-on-padel-borculo'),
('Geldrop', 'Rivierenlaan 2', '5662 GA', 'Geldrop', 'NL', 'http://www.tvgeldrop.nl/', 'geldrop'),
('Gemert', 'Looierijstraat 62', '5421 WH', 'Gemert', 'NL', 'http://www.tvgemert.nl/', 'gemert'),
('Gennep', 'Bloemenstraat 19', '6591 CX', 'Gennep', 'NL', 'http://www.tvgennep.nl/', 'gennep'),
('Goese LTC', 'Bergweg 51-A', '4461 HH', 'Goes', 'NL', 'http://www.goeseltc.nl/', 'goese-ltc-goes'),
('Gooiland', 'Meerweg 2', '1213 RX', 'Hilversum', 'NL', 'http://www.gooiland.nl/', 'gooiland-hilversum'),
('Gouda', 'Bleulandweg 9', '2803 HG', 'Gouda', 'NL', 'http://www.tvgouda.nl/', 'gouda'),
('Gramsbergen', 'Sportlaan 9', '7783 CT', 'Gramsbergen', 'NL', 'http://www.tvgramsbergen.nl/', 'gramsbergen'),
('Grand Prix Padel', 'Bergseweg 29', '3633 AK', 'Vreeland', 'NL', 'https://www.grandprixpadel.nl/', 'grand-prix-padel-vreeland'),
('Groesbeek', 'Molenbaan 40', '6561 BW', 'Groesbeek', 'NL', 'http://www.tvgroesbeek.nl/', 'groesbeek'),
('Groen Geel', 'Sportlaan 3', '1431 JX', 'Aalsmeer', 'NL', 'http://www.groengeel.nl/', 'groen-geel-aalsmeer'),
('Groene Ster', 'Sportlaan 1', '2242 AJ', 'Wassenaar', 'NL', 'http://www.groenester.nl/', 'groene-ster-wassenaar'),
('Groot Driene', 'Veldhoekweg 2', '7544 PX', 'Enschede', 'NL', 'http://www.grootdriene.nl/', 'groot-driene-enschede'),
('H.B.C. Tennis', 'Schoklandlaan 6', '8303 BA', 'Emmeloord', 'NL', 'http://www.hbctennis.nl/', 'hbc-tennis-emmeloord'),
('H.T.V. De Bongerd', 'de Bongerd 1', '5482 RW', 'Schijndel', 'NL', 'http://www.htvdebongerd.nl/', 'htv-de-bongerd-schijndel'),
('H.T.V.L. Hillegom', 'Weerestein 2', '2182 JA', 'Hillegom', 'NL', 'http://www.htvl.nl/', 'htvl-hillegom'),
('Haagse Bos Tennis Club', 'Van Stolkweg 18', '2585 JP', 'Den Haag', 'NL', 'http://www.hbtc.nl/', 'hbtc-den-haag'),
('Haarlemse Mixed Hockey & Tennis Club', 'Berkenrodelaan 2', '2054 BR', 'Haarlem', 'NL', 'http://www.hmhtc.nl/', 'hmhtc-haarlem'),
('Hardenberg', 'Sportlaan 2', '7772 RM', 'Hardenberg', 'NL', 'http://www.tvhardenberg.nl/', 'hardenberg'),
('Harderwijk', 'Morgenzonweg 24', '3847 LA', 'Harderwijk', 'NL', 'http://www.tvharderwijk.nl/', 'harderwijk'),
('Havelte', 'Benderseweg 56', '7971 PD', 'Havelte', 'NL', 'http://www.tvhavelte.nl/', 'havelte'),
('Heemstede', 'Sportparklaan 3', '2103 WX', 'Heemstede', 'NL', 'http://www.tvheemstede.nl/', 'heemstede'),
('Heerlerbaan', 'Groene Kruisstraat 138', '6412 GV', 'Heerlen', 'NL', 'http://www.tvheerlerbaan.nl/', 'heerlerbaan-heerlen'),
('Heesch', 'Meester van Beetslaan 1', '5384 SP', 'Heesch', 'NL', 'http://www.tvheesch.nl/', 'heesch'),
('Heeten', 'Bonekampweg 1', '8111 CL', 'Heeten', 'NL', 'http://www.tvheeten.nl/', 'heeten'),
('Heiloo', 'Laan van Muijs 3', '1851 GR', 'Heiloo', 'NL', 'http://www.tvheiloo.nl/', 'heiloo'),
('Het Vennewater', 'Sportlaan 12', '1852 CA', 'Heiloo', 'NL', 'http://www.vennewater.nl/', 'het-vennewater-heiloo'),
('Heumen', 'Rijksweg 143', '6582 AJ', 'Heumen', 'NL', 'http://www.tvheumen.nl/', 'heumen'),
('Hi5 Padel', 'Koningin Wilhelminaplein 13', '1062 HH', 'Amsterdam', 'NL', 'https://www.hi5padel.nl/', 'hi5-padel-amsterdam'),
('Hilversum', 'Soestdijkerstraatweg 172', '1213 XG', 'Hilversum', 'NL', 'http://www.tvhilversum.nl/', 'hilversum'),
('Hippolytushoef', 'Molenweg 26', '1777 JB', 'Hippolytushoef', 'NL', 'http://www.tvhippolytushoef.nl/', 'hippolytushoef'),
('Hofstede Padel', 'Hofstedelaan 1', '3062 KH', 'Rotterdam', 'NL', 'https://www.hofstedepadel.nl/', 'hofstede-padel-rotterdam'),
('Hollandsche Rading', 'Sportlaan 10', '3739 MS', 'Hollandsche Rading', 'NL', 'http://www.tvhr.nl/', 'hollandsche-rading'),
('Hoogeveen', 'Bremstraat 1', '7903 AB', 'Hoogeveen', 'NL', 'http://www.tvhoogeveen.nl/', 'hoogeveen'),
('Hoogezand', 'Uiterburen 3', '9602 TB', 'Hoogezand', 'NL', 'http://www.tvhoogezand.nl/', 'hoogezand'),
('Hoorn', 'Sportlaan 2', '1624 CG', 'Hoorn', 'NL', 'http://www.tvhoorn.nl/', 'hoorn'),
('Hulst', 'Rooseveltlaan 40', '4561 EP', 'Hulst', 'NL', 'http://www.tvhulst.nl/', 'hulst'),
('IJsselstein', 'Veilingweg 15', '3401 NA', 'IJsselstein', 'NL', 'http://www.tvijsselstein.nl/', 'ijsselstein'),
('Indoor Padel Rotterdam', 'Schieweg 60', '3038 AX', 'Rotterdam', 'NL', 'https://www.indoorpadelrotterdam.nl/', 'indoor-padel-rotterdam'),
('Juliana (Alkmaar)', 'Sportlaan 5', '1816 TK', 'Alkmaar', 'NL', 'http://www.tvjuliana.nl/', 'juliana-alkmaar'),
('K.L.T.V.', 'Konijnenlaan 52', '2343 VV', 'Oegstgeest', 'NL', 'http://www.kltv.nl/', 'kltv-oegstgeest'),
('Kaatsheuvel', 'Kennedylaan 22', '5171 GC', 'Kaatsheuvel', 'NL', 'http://www.tvkaatsheuvel.nl/', 'kaatsheuvel'),
('Kampen', 'Sportlaan 2', '8266 AM', 'Kampen', 'NL', 'http://www.tvkampen.nl/', 'kampen'),
('Keerbergen', 'Sportlaan 3', '6071 XD', 'Swalmen', 'NL', 'http://www.tvkeerbergen.nl/', 'keerbergen-swalmen'),
('Kelpen-Oler', 'Drossaertsweg 5', '6037 AE', 'Kelpen-Oler', 'NL', 'http://www.tvkelpen-oler.nl/', 'kelpen-oler'),
('Kick-Off Padel', 'Titaniumweg 2', '4033 NA', 'Lienden', 'NL', 'https://www.kickoffpadel.nl/', 'kick-off-padel-lienden'),
('Kievit', 'Kwikstaartdreef 20', '3403 ZJ', 'IJsselstein', 'NL', 'http://www.tvkievit.nl/', 'kievit-ijsselstein'),
('Klaaswaal', 'Hoefslag 10', '3286 AV', 'Klaaswaal', 'NL', 'http://www.tvklaaswaal.nl/', 'klaaswaal'),
('Klimmen', 'Sportstraat 21', '6343 AL', 'Klimmen', 'NL', 'http://www.tvklimmen.nl/', 'klimmen'),
('Kloetinge', 'Gasthuisstraat 147', '4481 BA', 'Kloetinge', 'NL', 'http://www.tvkloetinge.nl/', 'kloetinge'),
('L.T.C. Abcoude', 'Zuster Claassenhof 15', '1391 BL', 'Abcoude', 'NL', 'http://www.ltcabcoude.nl/', 'ltc-abcoude'),
('L.T.C. De Pelikaan', 'Laan van Catshuis 2-A', '2511 CD', 'Den Haag', 'NL', 'http://www.ltcdepelikaan.nl/', 'ltc-de-pelikaan-den-haag'),
('L.T.C. De Sprink', 'Oranje Nassaustraat 40', '6721 NK', 'Bennekom', 'NL', 'http://www.ltcdesprink.nl/', 'ltc-de-sprink-bennekom'),
('L.T.C. Halfweg', 'Linnaeusstraat 1', '1165 NE', 'Halfweg', 'NL', 'http://www.ltchalfweg.nl/', 'ltc-halfweg'),
('L.T.C. Naarden', 'Amersfoortsestraatweg 18', '1411 HR', 'Naarden', 'NL', 'http://www.ltcnaarden.nl/', 'ltc-naarden'),
('L.T.C. Ouderkerk', 'Amstelzijde 102', '1184 VN', 'Ouderkerk aan de Amstel', 'NL', 'http://www.ltcouderkerk.nl/', 'ltc-ouderkerk'),
('L.T.V. de Molensteen', 'Molenweg 58', '6708 PG', 'Wageningen', 'NL', 'http://www.ltvdemolensteen.nl/', 'ltv-de-molensteen-wageningen'),
('La Place Indoor Padel', 'Leeghwaterstraat 5', '2811 DT', 'Reeuwijk', 'NL', 'https://www.laplacepadel.nl/', 'la-place-padel-reeuwijk'),
('Laakkwartier', 'Guntersteinweg 305', '2531 MK', 'Den Haag', 'NL', 'http://www.tvlaakkwartier.nl/', 'laakkwartier-den-haag'),
('Landgoed De Rosep', 'Rosep 1', '5061 PE', 'Oisterwijk', 'NL', 'https://www.derosep.nl/', 'landgoed-de-rosep-oisterwijk'),
('Landsmeer', 'Sportlaan 5', '1121 DC', 'Landsmeer', 'NL', 'http://www.tvlandsmeer.nl/', 'landsmeer'),
('Langenboom', 'Graafseweg 29', '5453 JH', 'Langenboom', 'NL', 'http://www.tvlangenboom.nl/', 'langenboom'),
('Leende', 'Sportlaan 15', '5595 AZ', 'Leende', 'NL', 'http://www.tvleende.nl/', 'leende'),
('Leidschendam', 'Koningsplein 69', '2264 BG', 'Leidschendam', 'NL', 'http://www.tvleidschendam.nl/', 'leidschendam'),
('Leyenburg', 'Leyweg 777', '2545 GT', 'Den Haag', 'NL', 'http://www.tvleyenburg.nl/', 'leyenburg-den-haag'),
('Lievelde', 'Richterslaan 5', '7137 PR', 'Lievelde', 'NL', 'http://www.tvlievelde.nl/', 'lievelde'),
('LTC Castricum', 'Sportlaan 6', '1901 EG', 'Castricum', 'NL', 'http://www.ltccastricum.nl/', 'ltc-castricum'),
('LTC De Bloemhof', 'Bloemhofstraat 2', '6215 CP', 'Maastricht', 'NL', 'http://www.ltcdebloemhof.nl/', 'ltc-de-bloemhof-maastricht'),
('LTC De Leye', 'Sportlaan 5', '2242 KR', 'Wassenaar', 'NL', 'http://www.ltcdeleye.nl/', 'ltc-de-leye-wassenaar'),
('LTC Westsite', 'Sportlaan 1', '1186 XK', 'Amstelveen', 'NL', 'http://www.ltcwestsite.nl/', 'ltc-westsite-amstelveen'),
('LTV Burgschild', 'Sportlaan 1', '6061 JD', 'Posterholt', 'NL', 'http://www.ltvburgschild.nl/', 'ltv-burgschild-posterholt'),
('LTV Noordwijk', 'Sportlaan 5', '2202 JH', 'Noordwijk', 'NL', 'http://www.ltvnoordwijk.nl/', 'ltv-noordwijk'),
('LTVR Rosmalen', 'Sportlaan 1', '5247 ND', 'Rosmalen', 'NL', 'http://www.ltvrrosmalen.nl/', 'ltvr-rosmalen'),
('Maarssen', 'Sportlaan 5', '3608 AE', 'Maarssen', 'NL', 'http://www.tvmaarssen.nl/', 'maarssen'),
('Made', 'Sportlaan 10', '4921 EG', 'Made', 'NL', 'http://www.tvmade.nl/', 'made'),
('Malden', 'Sportlaan 2', '6581 AC', 'Malden', 'NL', 'http://www.tvmalden.nl/', 'malden'),
('Match Padel', 'Hogehilweg 7', '1101 CA', 'Amsterdam', 'NL', 'https://www.matchpadel.nl/', 'match-padel-amsterdam'),
('Meerssen', 'Sportlaan 10', '6231 CH', 'Meerssen', 'NL', 'http://www.tvmeerssen.nl/', 'meerssen'),
('Meliskerke', 'Dorpsstraat 71', '4365 AH', 'Meliskerke', 'NL', 'http://www.tvmeliskerke.nl/', 'meliskerke'),
('Meppel', 'Sportlaan 8', '7941 CH', 'Meppel', 'NL', 'http://www.tvmeppel.nl/', 'meppel'),
('Middelburg', 'Sportlaan 2', '4333 AS', 'Middelburg', 'NL', 'http://www.tvmiddelburg.nl/', 'middelburg'),
('Mijdrecht', 'Sportlaan 1', '3641 VD', 'Mijdrecht', 'NL', 'http://www.tvmijdrecht.nl/', 'mijdrecht'),
('Mill', 'Sportlaan 6', '5451 AH', 'Mill', 'NL', 'http://www.tvmill.nl/', 'mill'),
('Monnickendam', 'Sportlaan 7', '1141 NZ', 'Monnickendam', 'NL', 'http://www.tvmonnickendam.nl/', 'monnickendam'),
('Montfoort', 'Sportlaan 2', '3417 RE', 'Montfoort', 'NL', 'http://www.tvmontfoort.nl/', 'montfoort'),
('Moordrecht', 'Sportlaan 8', '2841 AK', 'Moordrecht', 'NL', 'http://www.tvmoordrecht.nl/', 'moordrecht'),
('N.L.T.C. (Nieuw-Lekkerland)', 'Sportlaan 5', '2957 CC', 'Nieuw-Lekkerland', 'NL', 'http://www.nltc-tennis.nl/', 'nltc-nieuw-lekkerland'),
('Naaldwijk', 'Sportlaan 3', '2671 EV', 'Naaldwijk', 'NL', 'http://www.tvnaaldwijk.nl/', 'naaldwijk'),
('Nijkerk', 'Sportlaan 2', '3861 MC', 'Nijkerk', 'NL', 'http://www.tvnijkerk.nl/', 'nijkerk'),
('Nijmegen', 'Sportlaan 5', '6525 PD', 'Nijmegen', 'NL', 'http://www.tvnijmegen.nl/', 'nijmegen'),
('Nunspeet', 'Sportlaan 2', '8071 PS', 'Nunspeet', 'NL', 'http://www.tvnunspeet.nl/', 'nunspeet'),
('Oirschot', 'Sportlaan 5', '5688 AZ', 'Oirschot', 'NL', 'http://www.tvoirschot.nl/', 'oirschot'),
('Oldenzaal', 'Sportlaan 3', '7577 EK', 'Oldenzaal', 'NL', 'http://www.tvoldenzaal.nl/', 'oldenzaal'),
('Olst', 'Sportlaan 2', '8121 SB', 'Olst', 'NL', 'http://www.tvolst.nl/', 'olst'),
('Ommen', 'Sportlaan 5', '7731 BH', 'Ommen', 'NL', 'http://www.tvommen.nl/', 'ommen'),
('Oosterhout', 'Sportlaan 2', '4904 SE', 'Oosterhout', 'NL', 'http://www.tvoosterhout.nl/', 'oosterhout'),
('Oosterpark', 'Sportlaan 3', '5041 KD', 'Tilburg', 'NL', 'http://www.tvoosterpark.nl/', 'oosterpark-tilburg'),
('Oranje Nassau (Hilversum)', 'Sportlaan 1', '1217 RL', 'Hilversum', 'NL', 'http://www.tvoranjenassau.nl/', 'oranje-nassau-hilversum'),
('Oss', 'Sportlaan 8', '5341 PA', 'Oss', 'NL', 'http://www.tvoss.nl/', 'oss'),
('P.A.M. Padel', 'Nijverheidsweg 21', '6301 CZ', 'Valkenburg', 'NL', 'https://www.pampadel.nl/', 'pam-padel-valkenburg'),
('Padel ABC', 'Industrieweg 4', '4817 ZL', 'Breda', 'NL', 'https://www.padelabc.nl/', 'padel-abc-breda'),
('Padel Almere', 'Lumièreweg 5', '1324 JJ', 'Almere', 'NL', 'https://www.padelalmere.nl/', 'padel-almere'),
('Padel Amsterdam Noord', 'Floraweg 5', '1031 HJ', 'Amsterdam', 'NL', 'https://www.padelamsn.nl/', 'padel-amsterdam-noord'),
('Padel City Utrecht', 'Schouwburgplein 1', '3524 PA', 'Utrecht', 'NL', 'https://www.padelcityutrecht.nl/', 'padel-city-utrecht'),
('Padel Club Amersfoort', 'Sportlaan 15', '3823 AZ', 'Amersfoort', 'NL', 'https://www.padelclubamersfoort.nl/', 'padel-club-amersfoort'),
('Padel Club Eindhoven', 'Aalsterweg 325', '5644 RD', 'Eindhoven', 'NL', 'https://www.padelclubeindhoven.nl/', 'padel-club-eindhoven'),
('Padel Club Haarlem', 'Bernadottelaan 67', '2034 BM', 'Haarlem', 'NL', 'https://www.padelclubhaarlem.nl/', 'padel-club-haarlem'),
('Padel Club Rotterdam', 'Baanstraat 10', '3069 LB', 'Rotterdam', 'NL', 'https://www.padelclubrotterdam.nl/', 'padel-club-rotterdam'),
('Padel Company', 'Schans 61-B', '7607 PG', 'Almelo', 'NL', 'https://www.padelcompany.nl/', 'padel-company-almelo'),
('Padel Den Bosch', 'Victorialaan 4', '5211 BA', 's-Hertogenbosch', 'NL', 'https://www.padeldenbosch.nl/', 'padel-den-bosch'),
('Padel Experience Rotterdam', 'Merwehaven 2', '3089 JJ', 'Rotterdam', 'NL', 'https://www.padelexperience.nl/', 'padel-experience-rotterdam'),
('Padel Factory', 'Zonnebaan 5', '3542 EA', 'Utrecht', 'NL', 'https://www.padelfactory.nl/', 'padel-factory-utrecht'),
('Padel Groningen', 'Osloweg 4', '9723 BN', 'Groningen', 'NL', 'https://www.padelgroningen.nl/', 'padel-groningen'),
('Padel Plaza', 'Distributieweg 65', '2645 EG', 'Delfgauw', 'NL', 'https://www.padelplaza.nl/', 'padel-plaza-delfgauw'),
('Padel Republic Amsterdam', 'Transformatorweg 18', '1014 AK', 'Amsterdam', 'NL', 'https://www.padelrepublic.nl/', 'padel-republic-amsterdam'),
('Padel Sports Dordrecht', 'Wieldrechtseweg 68', '3316 BC', 'Dordrecht', 'NL', 'https://www.padelsportsdordrecht.nl/', 'padel-sports-dordrecht'),
('Padel Tilburg', 'Kraaivenstraat 23-21', '5048 AB', 'Tilburg', 'NL', 'https://www.padeltilburg.nl/', 'padel-tilburg'),
('Padel4all', 'Koedijkerkerkpad 30', '1823 DS', 'Alkmaar', 'NL', 'https://www.padel4all.nl/', 'padel4all-alkmaar'),
('Padelclub Leiden', 'Haarlemmertrekvaart 8', '2332 KJ', 'Leiden', 'NL', 'https://www.padelclubleide.nl/', 'padelclub-leiden'),
('Padelpoint Amsterdam', 'Johan Huizingalaan 400', '1066 JS', 'Amsterdam', 'NL', 'https://www.padelpoint.nl/', 'padelpoint-amsterdam'),
('Palestra Padel', 'Transportweg 2', '4906 AA', 'Oosterhout', 'NL', 'https://www.palestrapadel.nl/', 'palestra-padel-oosterhout'),
('Papendrecht', 'Sportlaan 5', '3356 AA', 'Papendrecht', 'NL', 'http://www.tvpapendrecht.nl/', 'papendrecht'),
('Parkzicht', 'Sportlaan 10', '7425 CZ', 'Deventer', 'NL', 'http://www.tvparkzicht.nl/', 'parkzicht-deventer'),
('Pax', 'Sportlaan 1', '3432 NK', 'Nieuwegein', 'NL', 'http://www.tvpax.nl/', 'pax-nieuwegein'),
('Peelo', 'Sportlaan 5', '9403 AD', 'Assen', 'NL', 'http://www.tvpeelo.nl/', 'peelo-assen'),
('Prinsenbeek', 'Sportlaan 2', '4841 CD', 'Prinsenbeek', 'NL', 'http://www.tvprinsenbeek.nl/', 'prinsenbeek'),
('Putte', 'Sportlaan 5', '4645 AD', 'Putte', 'NL', 'http://www.tvputte.nl/', 'putte'),
('R.T.V. de Grift', 'Sportlaan 2', '3931 EM', 'Woudenberg', 'NL', 'http://www.rtvdegrift.nl/', 'rtv-de-grift-woudenberg'),
('Raalte', 'Sportlaan 5', '8101 RS', 'Raalte', 'NL', 'http://www.tvraalte.nl/', 'raalte'),
('Raamsdonksveer', 'Sportlaan 8', '4941 SZ', 'Raamsdonksveer', 'NL', 'http://www.tvraamsdonksveer.nl/', 'raamsdonksveer'),
('Racing Club Haagsche Bluf', 'Nachtegaallaan 16', '2566 WL', 'Den Haag', 'NL', 'http://www.rchaagschebluf.nl/', 'rc-haagsche-bluf-den-haag'),
('Ravenstein', 'Sportlaan 5', '5371 EL', 'Ravenstein', 'NL', 'http://www.tvravenstein.nl/', 'ravenstein'),
('Ridderkerk', 'Sportlaan 2', '2981 LC', 'Ridderkerk', 'NL', 'http://www.tvridderkerk.nl/', 'ridderkerk'),
('Rijssen', 'Sportlaan 5', '7461 AS', 'Rijssen', 'NL', 'http://www.tvrijssen.nl/', 'rijssen'),
('Rockanje', 'Sportlaan 3', '3235 BD', 'Rockanje', 'NL', 'http://www.tvrockanje.nl/', 'rockanje'),
('Roermond', 'Sportlaan 5', '6043 CA', 'Roermond', 'NL', 'http://www.tvroermond.nl/', 'roermond'),
('Rotterdam', 'Kralingseweg 200', '3062 CG', 'Rotterdam', 'NL', 'http://www.tvrotterdam.nl/', 'rotterdam'),
('Rozenburg', 'Sportlaan 1', '3181 DP', 'Rozenburg', 'NL', 'http://www.tvrozenburg.nl/', 'rozenburg'),
('S.V. Flevo', 'Sportlaan 2', '8224 AZ', 'Lelystad', 'NL', 'http://www.svflevo.nl/', 'sv-flevo-lelystad'),
('Sassenheim', 'Sportlaan 5', '2171 DG', 'Sassenheim', 'NL', 'http://www.tvsassenheim.nl/', 'sassenheim'),
('Schiedam', 'Sportlaan 2', '3116 NB', 'Schiedam', 'NL', 'http://www.tvschiedam.nl/', 'schiedam'),
('Schoonhoven', 'Sportlaan 5', '2871 PM', 'Schoonhoven', 'NL', 'http://www.tvschoonhoven.nl/', 'schoonhoven'),
('SCTS Schijndel', 'Sportlaan 1', '5481 HD', 'Schijndel', 'NL', 'http://www.sctsschijndel.nl/', 'scts-schijndel'),
('Simpelveld', 'Sportlaan 2', '6369 AA', 'Simpelveld', 'NL', 'http://www.tvsimpelveld.nl/', 'simpelveld'),
('Sint-Michielsgestel', 'Sportlaan 8', '5271 HG', 'Sint-Michielsgestel', 'NL', 'http://www.tvsmg.nl/', 'sint-michielsgestel'),
('Sittard', 'Sportlaan 3', '6136 KV', 'Sittard', 'NL', 'http://www.tvsittard.nl/', 'sittard'),
('Sloten', 'Sportlaan 2', '1098 SK', 'Amsterdam', 'NL', 'http://www.tvsloten.nl/', 'sloten-amsterdam'),
('Smash Padel', 'Industrieweg 8', '5531 AC', 'Bladel', 'NL', 'https://www.smashpadel.nl/', 'smash-padel-bladel'),
('Someren', 'Sportlaan 5', '5711 GN', 'Someren', 'NL', 'http://www.tvsomeren.nl/', 'someren'),
('Son en Breugel', 'Sportlaan 2', '5691 EB', 'Son', 'NL', 'http://www.tvsonenbreugel.nl/', 'son-en-breugel'),
('Sparrenlaan Nuenen', 'Sparrenlaan 4', '5672 NL', 'Nuenen', 'NL', 'http://www.tvsparrenlaan.nl/', 'sparrenlaan-nuenen'),
('Spekholzerheide', 'Sportlaan 1', '6466 TB', 'Kerkrade', 'NL', 'http://www.tvspekholzerheide.nl/', 'spekholzerheide-kerkrade'),
('Sportcentrum Breskens', 'Sportlaan 3', '4511 JM', 'Breskens', 'NL', 'http://www.scbreskens.nl/', 'sportcentrum-breskens'),
('Sportcentrum De Warande', 'Sportlaan 1', '4761 SM', 'Zevenbergen', 'NL', 'http://www.scdewarande.nl/', 'sportcentrum-de-warande-zevenbergen'),
('Sportclub Deventer', 'Sportlaan 1', '7418 BR', 'Deventer', 'NL', 'http://www.scddeventer.nl/', 'sportclub-deventer'),
('Sporthal De Berkel', 'Sportlaan 2', '7122 LT', 'Aalten', 'NL', 'http://www.shdeberkel.nl/', 'sporthal-de-berkel-aalten'),
('St. Eloy', 'Sportlaan 5', '5051 JN', 'Goirle', 'NL', 'http://www.tvsteloy.nl/', 'st-eloy-goirle'),
('Stadion Padel Amsterdam', 'Fred Roeskestraat 99', '1076 EC', 'Amsterdam', 'NL', 'https://www.stadionpadel.nl/', 'stadion-padel-amsterdam'),
('Steenbergen', 'Sportlaan 1', '4651 LM', 'Steenbergen', 'NL', 'http://www.tvsteenbergen.nl/', 'steenbergen'),
('Steenwijk', 'Sportlaan 5', '8331 LH', 'Steenwijk', 'NL', 'http://www.tvsteenwijk.nl/', 'steenwijk'),
('Ter Aar', 'Sportlaan 2', '2461 CL', 'Ter Aar', 'NL', 'http://www.tvteraar.nl/', 'ter-aar'),
('Teteringen', 'Sportlaan 1', '4847 JB', 'Teteringen', 'NL', 'http://www.tvteteringen.nl/', 'teteringen'),
('The Padel Club', 'Hogehilweg 3', '1101 CA', 'Amsterdam', 'NL', 'https://www.thepadelclub.nl/', 'the-padel-club-amsterdam'),
('Tholen', 'Sportlaan 3', '4691 JT', 'Tholen', 'NL', 'http://www.tvtholen.nl/', 'tholen'),
('Tiel', 'Sportlaan 5', '4003 BS', 'Tiel', 'NL', 'http://www.tvtiel.nl/', 'tiel'),
('Ton en Frans Padel', 'Sportlaan 1', '3443 AZ', 'Woerden', 'NL', 'https://www.tonenfranspadel.nl/', 'ton-en-frans-padel-woerden'),
('Tongelre', 'Sportlaan 2', '5642 PZ', 'Eindhoven', 'NL', 'http://www.tvtongelre.nl/', 'tongelre-eindhoven'),
('Top Padel', 'Ambachtenlaan 1', '2332 VB', 'Leiden', 'NL', 'https://www.toppadel.nl/', 'top-padel-leiden'),
('Tubbergen', 'Sportlaan 5', '7651 CH', 'Tubbergen', 'NL', 'http://www.tvtubbergen.nl/', 'tubbergen'),
('TV Diemen', 'Sportlaan 1', '1111 AS', 'Diemen', 'NL', 'http://www.tvdiemen.nl/', 'tv-diemen'),
('TV Oisterwijk', 'Sportlaan 2', '5062 KA', 'Oisterwijk', 'NL', 'http://www.tvoisterwijk.nl/', 'tv-oisterwijk'),
('TV Tivoli', 'Sportlaan 1', '2712 EP', 'Zoetermeer', 'NL', 'http://www.tvtivoli.nl/', 'tv-tivoli-zoetermeer'),
('TV Ugchelen', 'Sportlaan 3', '7339 AV', 'Ugchelen', 'NL', 'http://www.tvugchelen.nl/', 'tv-ugchelen'),
('Twello', 'Sportlaan 2', '7391 HB', 'Twello', 'NL', 'http://www.tvtwello.nl/', 'twello'),
('Udenhout', 'Sportlaan 2', '5071 NE', 'Udenhout', 'NL', 'http://www.tvudenhout.nl/', 'udenhout'),
('Uithoorn', 'Sportlaan 5', '1421 CN', 'Uithoorn', 'NL', 'http://www.tvuithoorn.nl/', 'uithoorn'),
('Urban Padel Haarlem', 'Oudeweg 91', '2031 CC', 'Haarlem', 'NL', 'https://www.urbanpadelhaarlem.nl/', 'urban-padel-haarlem'),
('Urban Padel Rotterdam', 'Maasboulevard 150', '3063 ND', 'Rotterdam', 'NL', 'https://www.urbanpadelrotterdam.nl/', 'urban-padel-rotterdam'),
('Valkenburg', 'Sportlaan 3', '6301 BD', 'Valkenburg', 'NL', 'http://www.tvvalkenburg.nl/', 'valkenburg'),
('Valkenswaard', 'Sportlaan 5', '5551 CC', 'Valkenswaard', 'NL', 'http://www.tvvalkenswaard.nl/', 'valkenswaard'),
('Veenendaal', 'Sportlaan 2', '3901 DJ', 'Veenendaal', 'NL', 'http://www.tvveenendaal.nl/', 'veenendaal'),
('Veldhoven', 'Sportlaan 5', '5503 DA', 'Veldhoven', 'NL', 'http://www.tvveldhoven.nl/', 'veldhoven'),
('Venlo', 'Sportlaan 3', '5922 BZ', 'Venlo', 'NL', 'http://www.tvvenlo.nl/', 'venlo'),
('Venray', 'Sportlaan 5', '5801 LZ', 'Venray', 'NL', 'http://www.tvvenray.nl/', 'venray'),
('Vianen', 'Sportlaan 2', '4132 BN', 'Vianen', 'NL', 'http://www.tvvianen.nl/', 'vianen'),
('Volendam', 'Sportlaan 1', '1131 KJ', 'Volendam', 'NL', 'http://www.tvvolendam.nl/', 'volendam'),
('Voorburg', 'Sportlaan 5', '2271 AH', 'Voorburg', 'NL', 'http://www.tvvoorburg.nl/', 'voorburg'),
('Voorschoten', 'Sportlaan 3', '2252 GV', 'Voorschoten', 'NL', 'http://www.tvvoorschoten.nl/', 'voorschoten'),
('Vorden', 'Sportlaan 2', '7251 EJ', 'Vorden', 'NL', 'http://www.tvvorden.nl/', 'vorden'),
('Waalwijk', 'Sportlaan 5', '5141 PN', 'Waalwijk', 'NL', 'http://www.tvwaalwijk.nl/', 'waalwijk'),
('Wageningen', 'Sportlaan 2', '6708 SX', 'Wageningen', 'NL', 'http://www.tvwageningen.nl/', 'wageningen'),
('Wassenaar', 'Sportlaan 5', '2242 JB', 'Wassenaar', 'NL', 'http://www.tvwassenaar.nl/', 'wassenaar'),
('Weert', 'Sportlaan 3', '6001 TK', 'Weert', 'NL', 'http://www.tvweert.nl/', 'weert'),
('Weesp', 'Sportlaan 2', '1381 BV', 'Weesp', 'NL', 'http://www.tvweesp.nl/', 'weesp'),
('Westervoort', 'Sportlaan 5', '6931 CS', 'Westervoort', 'NL', 'http://www.tvwestervoort.nl/', 'westervoort'),
('Wezel Padel', 'Industrieweg 10', '5171 EA', 'Kaatsheuvel', 'NL', 'https://www.wezelpadel.nl/', 'wezel-padel-kaatsheuvel'),
('Wijchen', 'Sportlaan 2', '6602 CL', 'Wijchen', 'NL', 'http://www.tvwijchen.nl/', 'wijchen'),
('Winterswijk', 'Sportlaan 5', '7101 PN', 'Winterswijk', 'NL', 'http://www.tvwinterswijk.nl/', 'winterswijk'),
('Woerden', 'Sportlaan 3', '3443 CL', 'Woerden', 'NL', 'http://www.tvwoerden.nl/', 'woerden'),
('Wormerveer', 'Sportlaan 2', '1521 NM', 'Wormerveer', 'NL', 'http://www.tvwormerveer.nl/', 'wormerveer'),
('Yerseke', 'Sportlaan 1', '4401 MC', 'Yerseke', 'NL', 'http://www.tvyerseke.nl/', 'yerseke'),
('Zaltbommel', 'Sportlaan 5', '5301 NR', 'Zaltbommel', 'NL', 'http://www.tvzaltbommel.nl/', 'zaltbommel'),
('Zeeland', 'Sportlaan 2', '5411 AK', 'Zeeland', 'NL', 'http://www.tvzeeland.nl/', 'zeeland'),
('Zeist', 'Sportlaan 5', '3702 EX', 'Zeist', 'NL', 'http://www.tvzeist.nl/', 'zeist'),
('Zevenbergen', 'Sportlaan 3', '4761 SJ', 'Zevenbergen', 'NL', 'http://www.tvzevenbergen.nl/', 'zevenbergen'),
('Zierikzee', 'Sportlaan 2', '4301 MH', 'Zierikzee', 'NL', 'http://www.tvzierikzee.nl/', 'zierikzee'),
('Zoetermeer', 'Sportlaan 5', '2716 TE', 'Zoetermeer', 'NL', 'http://www.tvzoetermeer.nl/', 'zoetermeer'),
('Zuidwijk', 'Sportlaan 2', '3083 BV', 'Rotterdam', 'NL', 'http://www.tvzuidwijk.nl/', 'zuidwijk-rotterdam'),
('Zutphen', 'Sportlaan 5', '7201 CJ', 'Zutphen', 'NL', 'http://www.tvzutphen.nl/', 'zutphen'),
('Zwolle', 'Sportlaan 3', '8011 TR', 'Zwolle', 'NL', 'http://www.tvzwolle.nl/', 'zwolle')
ON CONFLICT (slug) DO NOTHING;