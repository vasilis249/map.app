import { APP_NAME, LEGAL } from "@/lib/brand";

/**
 * Privacy policy and terms of use (el / en) — DRAFTS written from what the app actually does (retention times,
 * providers, settings; see CLAUDE.md decisions D9–D22). A lawyer must review them and the owner fill in the legal
 * entity (src/lib/brand.ts → LEGAL) before release. Keep them in step with the code: if a retention time or a provider
 * changes, change it here too.
 */

export interface LegalSection {
  title: string;
  /** Paragraphs; a line starting with "• " is a list item. */
  body: string[];
}
export interface LegalDoc {
  title: string;
  updated: string;
  sections: LegalSection[];
}

const A = APP_NAME;
const L = LEGAL;

const privacyEl: LegalDoc = {
  title: "Πολιτική απορρήτου",
  updated: `Τελευταία ενημέρωση: ${L.updated}`,
  sections: [
    {
      title: "Ποιοι είμαστε",
      body: [
        `Η εφαρμογή ${A} παρέχεται από την ${L.entity}, ${L.address} («εμείς»), που είναι υπεύθυνη επεξεργασίας των δεδομένων σου. Επικοινωνία για θέματα απορρήτου: ${L.email}.`,
      ],
    },
    {
      title: "Τι δεδομένα επεξεργαζόμαστε και γιατί",
      body: [
        "• Λογαριασμός: email, κωδικός (αποθηκεύεται μόνο κρυπτογραφημένος), όνομα, όνομα χρήστη, βιογραφικό, φωτογραφία προφίλ και η δήλωσή σου ότι είσαι 18 ετών και άνω. Χρειάζονται για να λειτουργεί ο λογαριασμός σου.",
        "• Τοποθεσία: μόνο αν ενεργοποιήσεις την κοινοποίηση. Κρατάμε μόνο την τελευταία σου θέση (με ακρίβεια, κατεύθυνση και ταχύτητα), όχι ιστορικό. Σβήνεται αμέσως όταν κλείσεις την κοινοποίηση (ή πατήσεις «Αόρατος») και αυτόματα μετά από 1 ώρα χωρίς ενημέρωση. Τη βλέπουν μόνο όσοι διάλεξες: οι φίλοι σου (αμοιβαίο follow) ή και όσοι βρίσκονται έως 200 μέτρα από σένα και μοιράζονται κι αυτοί. Από την ταχύτητα δείχνουμε στους άλλους μόνο αν κινήθηκες με ταχύτητα οχήματος τα τελευταία 5 λεπτά (για να εμφανιστείς ως αυτοκίνητο στον χάρτη), ποτέ την ίδια την ταχύτητα.",
        "• Πλοήγηση και αναζήτηση: όταν ζητάς διαδρομή, το σημείο εκκίνησης και ο προορισμός στέλνονται στον διακομιστή μας και από εκεί στον πάροχο διαδρομών (Stadia Maps), χωρίς στοιχεία ταυτότητάς σου. Το ίδιο ισχύει για ό,τι γράφεις στην αναζήτηση προορισμού. Οι απαντήσεις κρατιούνται προσωρινά (έως 5 λεπτά οι διαδρομές, έως 1 ημέρα οι αναζητήσεις) χωρίς να συνδέονται με εσένα. Οι θέσεις σου κατά την πλοήγηση μένουν στη συσκευή σου.",
        "• Φωνή (push-to-talk): όσο κρατάς το κουμπί, η φωνή σου μεταδίδεται ζωντανά στο άτομο που μιλάς και αποθηκεύεται για 24 ώρες, ώστε να την ακούσει αργότερα και να μπορούμε να ελέγξουμε αναφορές κατάχρησης· μετά σβήνεται. Κρατάμε έως 3 ημέρες μόνο τεχνικούς μετρητές σύνδεσης (όχι ήχο).",
        "• Αναφορές δρόμου (κίνηση, αστυνομία, τροχαίο, κίνδυνος, κλειστός δρόμος, κάμερα, οδική βοήθεια): είδος και λεπτομέρεια, θέση, ώρα, κατεύθυνση και ποιος την έκανε — το τελευταίο δεν φαίνεται σε άλλους χρήστες. Ισχύουν από 30 λεπτά (κίνηση) έως 1 ημέρα (έργα)· οι κάμερες 30 ημέρες, όσο τις επιβεβαιώνουν. Σβήνονται 1 ημέρα αφού λήξουν. Αν μια αναφορά σου αφαιρεθεί ως λανθασμένη, κρατάμε για 7 ημέρες μόνο ότι αφαιρέθηκε (χωρίς θέση), για την αποτροπή κατάχρησης.",
        "• Θέσεις στάθμευσης: όταν δηλώνεις ότι φεύγεις ή πάρκαρες, η θέση, η ώρα και ποιος τη δήλωσε (δεν φαίνεται σε άλλους)· ισχύει 15 λεπτά (ελεύθερη) ή 10 λεπτά (κατειλημμένη) και σβήνεται 1 ώρα μετά. Το σημείο όπου πάρκαρες κρατιέται μόνο στο κινητό σου, για να σε ρωτήσουμε αν ελευθέρωσες τη θέση όταν φύγεις.",
        "• Πλοήγηση: η αφετηρία, ο προορισμός και οι επιλογές διαδρομής (αποφυγή διοδίων / αυτοκινητοδρόμων, κλειστοί δρόμοι) πάνε στον πάροχο διαδρομών για να υπολογιστεί η διαδρομή και τα όρια ταχύτητας της· το Σπίτι, η Δουλειά και οι πρόσφατοι προορισμοί σου μένουν μόνο στο κινητό σου.",
        "• Κοινωνικά: ποιους ακολουθείς και ποιοι σε ακολουθούν, αποκλεισμοί, ειδοποιήσεις, αναφορές κατάχρησης που κάνεις ή γίνονται για σένα (κρατιούνται για τον έλεγχο από τους διαχειριστές).",
        "• Τεχνικά: καταγραφή ενεργειών για τα όρια χρήσης (π.χ. πόσες αναφορές έκανες την τελευταία ώρα), που σβήνεται μετά από 2 ημέρες, και τα αρχεία καταγραφής των παρόχων φιλοξενίας.",
        "Δεν χρησιμοποιούμε διαφημίσεις, αναλυτικά εργαλεία (analytics) ή παρακολούθηση (tracking) και δεν πουλάμε δεδομένα.",
      ],
    },
    {
      title: "Νομική βάση",
      body: [
        "Εκτέλεση της σύμβασης μαζί σου (λειτουργία του λογαριασμού, του χάρτη, της πλοήγησης και της επικοινωνίας), συγκατάθεσή σου (κοινοποίηση τοποθεσίας, πρόσβαση σε μικρόφωνο και φωτογραφίες — την ανακαλείς οποτεδήποτε από τις ρυθμίσεις της εφαρμογής και του τηλεφώνου) και έννομο συμφέρον (ασφάλεια, αποτροπή κατάχρησης, έλεγχος αναφορών).",
      ],
    },
    {
      title: "Ποιοι άλλοι επεξεργάζονται δεδομένα για εμάς",
      body: [
        "• Supabase (βάση δεδομένων, σύνδεση, αποθήκευση αρχείων, ζωντανή μετάδοση φωνής).",
        "• Cloudflare (φιλοξενία της εφαρμογής).",
        "• Stadia Maps (υπολογισμός διαδρομών και αναζήτηση διευθύνσεων: λαμβάνει αφετηρία, προορισμό, κείμενο αναζήτησης).",
        "• OpenFreeMap (πλακίδια χάρτη: όπως κάθε διακομιστής, βλέπει τη διεύθυνση IP της συσκευής σου).",
        "• Apple: η φωνή της πλοήγησης δημιουργείται στη συσκευή σου.",
        "Με όλους υπάρχουν συμβάσεις επεξεργασίας. Όπου δεδομένα μεταφέρονται εκτός ΕΕ, γίνεται με τις τυποποιημένες συμβατικές ρήτρες της Ευρωπαϊκής Επιτροπής ή άλλη νόμιμη εγγύηση.",
      ],
    },
    {
      title: "Τα δικαιώματά σου",
      body: [
        "Έχεις δικαίωμα πρόσβασης, διόρθωσης, διαγραφής, περιορισμού, φορητότητας και εναντίωσης. Διορθώνεις τα στοιχεία σου από το Προφίλ και διαγράφεις τον λογαριασμό σου οποτεδήποτε από Προφίλ → «Διαγραφή λογαριασμού»: σβήνονται αμέσως το προφίλ, οι φωτογραφίες, η θέση, οι φωνές, οι αναφορές δρόμου και οι σχέσεις σου· αναφορές κατάχρησης που έκανες για άλλους μένουν για τον έλεγχο χωρίς το όνομά σου. Για τα υπόλοιπα γράψε μας στο " + L.email + ".",
        "Μπορείς να υποβάλεις καταγγελία στην Αρχή Προστασίας Δεδομένων Προσωπικού Χαρακτήρα (www.dpa.gr).",
      ],
    },
    {
      title: "Ασφάλεια",
      body: [
        "Όλες οι συνδέσεις είναι κρυπτογραφημένες. Η πρόσβαση στη βάση ελέγχεται ανά εγγραφή: κάθε χρήστης βλέπει μόνο ό,τι επιτρέπεται να δει, και κάθε αλλαγή περνά από ελέγχους στον διακομιστή. Τα κλειδιά των παρόχων δεν βρίσκονται ποτέ στην εφαρμογή.",
      ],
    },
    {
      title: "Ανήλικοι",
      body: ["Η εφαρμογή απευθύνεται μόνο σε ενήλικες (18+), επειδή δείχνει ακριβή θέση σε κοντινούς χρήστες."],
    },
    {
      title: "Αλλαγές",
      body: ["Αν αλλάξει αυτή η πολιτική, θα το δεις στην εφαρμογή πριν ισχύσουν ουσιαστικές αλλαγές."],
    },
  ],
};

const termsEl: LegalDoc = {
  title: "Όροι χρήσης",
  updated: `Τελευταία ενημέρωση: ${L.updated}`,
  sections: [
    {
      title: "Αποδοχή",
      body: [
        `Με τη δημιουργία λογαριασμού στο ${A} αποδέχεσαι αυτούς τους όρους και την Πολιτική απορρήτου. Πρέπει να είσαι τουλάχιστον 18 ετών. Πάροχος: ${L.entity}, ${L.address}.`,
      ],
    },
    {
      title: "Ασφάλεια στον δρόμο",
      body: [
        "Η οδήγηση έχει πάντα προτεραιότητα. Τηρείς τον Κώδικα Οδικής Κυκλοφορίας και δεν χειρίζεσαι το τηλέφωνο με τρόπο που σου αποσπά την προσοχή. Στερέωσε τη συσκευή σε βάση· για αναζήτηση ή ανάγνωση σταμάτα με ασφάλεια (η εφαρμογή τις κλειδώνει όσο κινείσαι).",
        "Οι οδηγίες πλοήγησης, οι χρόνοι άφιξης και οι αναφορές άλλων χρηστών είναι ενδεικτικά και μπορεί να είναι λάθος ή παλιά. Ακολουθείς πάντα τη σήμανση, τις συνθήκες του δρόμου και τις οδηγίες των αρχών.",
      ],
    },
    {
      title: "Κοινοποίηση θέσης",
      body: [
        "Εσύ αποφασίζεις αν και με ποιους μοιράζεσαι τη θέση σου. Με την επιλογή «Φίλοι και όσοι είναι κοντά», άγνωστοι έως 200 μέτρα μπορούν να δουν την ακριβή θέση σου και να σου μιλήσουν. Μπορείς να γίνεις «Αόρατος» με ένα πάτημα, να ορίσεις ποιοι σου μιλούν και να αποκλείσεις οποιονδήποτε.",
      ],
    },
    {
      title: "Συμπεριφορά και περιεχόμενο",
      body: [
        "Απαγορεύονται: παρενόχληση, απειλές, ρητορική μίσους, σεξουαλικό περιεχόμενο, παρακολούθηση άλλων χωρίς τη θέλησή τους, ψευδείς αναφορές δρόμου, spam, παρουσίαση ως άλλο πρόσωπο, και κάθε παράνομη χρήση.",
        "Ό,τι λες ή αναφέρεις το διαθέτεις στους παραλήπτες και στους χρήστες που το βλέπουν, μόνο για τη λειτουργία της υπηρεσίας. Μπορείς να αναφέρεις και να αποκλείσεις χρήστες και περιεχόμενο· οι διαχειριστές ελέγχουν τις αναφορές και μπορούν να αφαιρέσουν περιεχόμενο ή να αναστείλουν λογαριασμούς.",
      ],
    },
    {
      title: "Διαθεσιμότητα και ευθύνη",
      body: [
        "Η υπηρεσία παρέχεται «ως έχει». Δεν εγγυόμαστε ότι θα είναι πάντα διαθέσιμη ή χωρίς σφάλματα. Στον βαθμό που επιτρέπει ο νόμος, δεν ευθυνόμαστε για ζημίες από τη χρήση της ή από περιεχόμενο άλλων χρηστών. Οι υποχρεωτικές διατάξεις προστασίας καταναλωτή δεν θίγονται.",
      ],
    },
    {
      title: "Λήξη",
      body: [
        "Μπορείς να διαγράψεις τον λογαριασμό σου οποτεδήποτε (Προφίλ → «Διαγραφή λογαριασμού»). Μπορούμε να αναστείλουμε λογαριασμό που παραβιάζει αυτούς τους όρους.",
      ],
    },
    {
      title: "Χάρτες και τρίτοι",
      body: [
        "Δεδομένα χάρτη © OpenStreetMap contributors (ODbL), πλακίδια από OpenFreeMap, διαδρομές και αναζήτηση από Stadia Maps. Ισχύουν και οι όροι τους.",
      ],
    },
    {
      title: "Δίκαιο και επικοινωνία",
      body: [`Διέπονται από το ελληνικό δίκαιο· αρμόδια τα δικαστήρια ${L.courts}. Επικοινωνία: ${L.email}.`],
    },
  ],
};

const privacyEn: LegalDoc = {
  title: "Privacy policy",
  updated: `Last updated: ${L.updated}`,
  sections: [
    { title: "Who we are", body: [`${A} is provided by ${L.entity}, ${L.address} ("we"), the controller of your data. Privacy contact: ${L.email}.`] },
    {
      title: "What we process and why",
      body: [
        "• Account: email, password (stored only hashed), name, username, bio, profile photo and your declaration that you are 18 or older — to run your account.",
        "• Location: only if you turn sharing on. We keep only your latest position (with accuracy, heading and speed), never a history. It is deleted as soon as you stop sharing (or tap Ghost) and automatically after 1 hour without an update. Only the people you chose see it: your friends (mutual follows), or also people within 200 m who share too. Of your speed, others only learn whether you moved at vehicle speed in the last 5 minutes (to show you as a car), never the speed itself.",
        "• Navigation and search: when you ask for a route, the start and destination go to our server and from there to our routing provider (Stadia Maps), without your identity; the same for what you type in destination search. Answers are cached briefly (routes up to 5 minutes, searches up to 1 day), not linked to you. Your positions while navigating stay on your device.",
        "• Voice (push to talk): while you hold the button, your voice is streamed live to the person you talk to and kept for 24 hours so they can play it later and reports can be reviewed; then it is deleted. Technical connection counters (no audio) are kept up to 3 days.",
        "• Road reports (traffic, police, accident, hazard, closed road, camera, roadside help): kind and detail, place, time, direction and who made it — the last never shown to other users. They last from 30 minutes (traffic) to 1 day (road works); cameras 30 days while people confirm them. Deleted 1 day after they expire. If a report of yours is removed as wrong, we keep only that fact (no place) for 7 days, against abuse.",
        "• Parking spots: when you say you're leaving or you parked, the place, time and who said it (not shown to others); shown for 15 minutes (free) or 10 minutes (taken), deleted an hour later. Where you parked is kept only on your phone, to ask whether you freed the spot when you leave.",
        "• Navigation: your start, destination and route options (avoid tolls / motorways, closed roads) go to the routing provider to compute the route and its speed limits; Home, Work and your recent destinations stay on your phone only.",
        "• Social: who you follow and who follows you, blocks, notifications, abuse reports you make or that concern you (kept for moderation).",
        "• Technical: an action log for rate limits (deleted after 2 days) and our hosting providers' logs.",
        "No ads, no analytics, no tracking, and we never sell data.",
      ],
    },
    {
      title: "Legal basis",
      body: [
        "Performance of our contract with you (account, map, navigation, talk), your consent (location sharing, microphone and photo access — withdraw it any time in the app or the phone's settings) and legitimate interest (security, abuse prevention, moderation).",
      ],
    },
    {
      title: "Processors",
      body: [
        "• Supabase (database, sign-in, file storage, live voice).",
        "• Cloudflare (app hosting).",
        "• Stadia Maps (routing and address search: receives start, destination, search text).",
        "• OpenFreeMap (map tiles: like any server, it sees your device's IP address).",
        "• Apple: navigation voice is generated on your device.",
        "All under data processing agreements; transfers outside the EU rely on the European Commission's standard contractual clauses or another lawful safeguard.",
      ],
    },
    {
      title: "Your rights",
      body: [
        `Access, rectification, erasure, restriction, portability and objection. Edit your details in Profile; delete your account any time in Profile → "Delete account": your profile, photos, position, voices, road reports and connections are deleted at once; abuse reports you made about others stay for moderation without your name. For anything else write to ${L.email}. You may complain to your data protection authority (in Greece: www.dpa.gr).`,
      ],
    },
    { title: "Security", body: ["All connections are encrypted; database access is checked per row on the server; provider keys never ship in the app."] },
    { title: "Minors", body: ["Adults only (18+), because the app shows exact positions to nearby users."] },
    { title: "Changes", body: ["If this policy changes materially, you will see it in the app before it applies."] },
  ],
};

const termsEn: LegalDoc = {
  title: "Terms of use",
  updated: `Last updated: ${L.updated}`,
  sections: [
    { title: "Acceptance", body: [`By creating an account in ${A} you accept these terms and the privacy policy. You must be 18 or older. Provider: ${L.entity}, ${L.address}.`] },
    {
      title: "Road safety",
      body: [
        "Driving always comes first. Obey traffic law and never handle the phone in a way that distracts you; mount it in a holder; stop safely to search or read (the app locks them while you move).",
        "Directions, arrival times and other users' reports are indicative and may be wrong or outdated. Always follow road signs, conditions and the authorities.",
      ],
    },
    { title: "Sharing your position", body: ["You decide whether and with whom. With \"Friends and people nearby\", strangers within 200 m can see your exact position and talk to you. Go Ghost with one tap, choose who may talk to you, block anyone."] },
    {
      title: "Conduct and content",
      body: [
        "Not allowed: harassment, threats, hate speech, sexual content, tracking others against their will, false road reports, spam, impersonation, anything illegal.",
        "What you say or report is made available to its recipients / viewers only to run the service. You can report and block; moderators review reports and may remove content or suspend accounts.",
      ],
    },
    { title: "Availability and liability", body: ["Provided \"as is\", without guarantee of availability. To the extent the law allows, we are not liable for damage from its use or from other users' content. Mandatory consumer rights are unaffected."] },
    { title: "Ending", body: ["Delete your account any time (Profile → \"Delete account\"). We may suspend accounts that break these terms."] },
    { title: "Maps and third parties", body: ["Map data © OpenStreetMap contributors (ODbL), tiles by OpenFreeMap, routing and search by Stadia Maps; their terms apply too."] },
    { title: "Law and contact", body: [`Greek law applies; courts of ${L.courts}. Contact: ${L.email}.`] },
  ],
};

export function legalDoc(kind: "privacy" | "terms", lang: string): LegalDoc {
  const en = lang.startsWith("en");
  if (kind === "privacy") return en ? privacyEn : privacyEl;
  return en ? termsEn : termsEl;
}
