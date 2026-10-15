// ===== Event details – edit freely =====
window.APP_CONFIG = {
  // Where the live server runs. Leave "" when these pages are served by the live server itself.
  // When the pages are on Vercel, put the laptop's tunnel address here, e.g. "https://live.yourdomain.com"
  server: "https://opt-tons-swim-let.trycloudflare.com",

  // Cloud relay (Cloudflare Worker) used when live.js mode is "cloud": phones -> Cloudflare -> viewers, no laptop
  cloud: "",

  // GitHub repository the /publish page saves live links to
  repo: "MeetDave-25/live-brodcasting",

  name: "RANGVAASA",
  year: "2026",
  host: "LJCCA × AIRA LAB",
  edition: "Navratri Utsav 2026",
  tagline2: "[ Tradition × Youth ]",

  // When coverage begins (India time). Viewers see a countdown before this.
  startTime: "2026-10-16T12:00:00+05:30",

  // One entry per camera phone. id must be cam1 ... cam6.
  angles: [
    { id: "cam1", name: "Main stage" },
    { id: "cam2", name: "The circle" },
    { id: "cam3", name: "Dhol & singers" },
    { id: "cam4", name: "The Art Adda" },
  ],

  // 24-hour times, so the app can mark what's happening now.
  // Placeholder programme – replace with the real one.
  schedule: [
    { time: "12:00", label: "Opening",          title: "Aarti & welcome",     note: "Lamps lit at the heart of the ground" },
    { time: "12:30", label: "Creative club",    title: "The Art Adda launch", note: "Resin, crochet, chocolate & handmade crafts" },
    { time: "13:30", label: "Authentic beats",  title: "The Folk Rhythm",     note: "Garba to live dhol and Gujarati folk" },
    { time: "15:30", label: "Sticks out",       title: "Dandiya Raas",        note: "Everyone into the circle" },
    { time: "17:00", label: "Festive dress",    title: "A Thousand Colours",  note: "Best dressed · Best pair · Best dancer" },
    { time: "17:45", label: "Until dusk",       title: "Final Garba",         note: "One rhythm, till the dhol stops" },
  ],

  // Cards in the Details section. icon: calendar | clock | pin
  details: [
    { icon: "calendar", label: "Date",             title: "16 October 2026",  note: "Friday celebration" },
    { icon: "clock",    label: "Schedule",         title: "12:00 PM Onwards", note: "Afternoon festivities extending into the twilight hours" },
    { icon: "pin",      label: "Location & venue", title: "LJCCA Ground, Vastrapur", note: "Ahmedabad, Gujarat 380015 — Near Vastrapur Lake" },
  ],
  mapUrl: "https://www.google.com/maps/search/?api=1&query=LJ+College+of+Computer+Applications+Vastrapur+Ahmedabad",
  coords: "[ 23.03° N, 72.52° E ]",
};
