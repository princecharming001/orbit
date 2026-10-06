/**
 * 30 LinkedIn "Connections.csv" rows with the kinds of names real exports contain: suffixes, credentials,
 * pronouns, emoji, company tails, all-caps or all-lowercase, accents, particles, apostrophes and hyphens.
 * `expect` is what the person should be called (first name for the greeting, full display name).
 */
export const MESSY_CONNECTIONS_CSV = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address using this setting https://www.linkedin.com/psettings/privacy/email. You can learn more here https://www.linkedin.com/help/linkedin/answer/261"

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Sam,"Lee, Jr.",https://www.linkedin.com/in/sam-lee-jr,,Acme Corp,CEO,10 Oct 2024
John,Smith III,https://www.linkedin.com/in/john-smith-3,,Stripe,Software Engineer,12 Mar 2025
José,Núñez-García,https://www.linkedin.com/in/jose-nunez-garcia,,"Bain & Company, Inc.",Associate Consultant,1 Sep 2023
Priya,"Patel, MBA",https://www.linkedin.com/in/priya-patel-mba,,Figma,Product Manager,12 Sept 2025
Dr. Elena,Rodriguez,https://www.linkedin.com/in/elena-rodriguez,,McKinsey & Company,Engagement Manager,2025-01-15
Daniel,Kim 🚀,https://www.linkedin.com/in/daniel-kim-1,,Stripe,Software Engineer,12 Mar 2025
Maya (she/her),Wu,https://www.linkedin.com/in/maya-wu,,Figma,Designer,03 Feb 2025
CHRISTOPHER,O'BRIEN,https://www.linkedin.com/in/chris-obrien,,Goldman Sachs & Co. LLC,Analyst,04 Apr 2024
tom,wu,https://www.linkedin.com/in/tom-wu,,Datadog,Engineer,05 May 2024
Ana,de la Cruz,https://www.linkedin.com/in/ana-de-la-cruz,,PwC,Senior Associate,06 Jun 2024
Wei,Zhang | Ex-Google,https://www.linkedin.com/in/wei-zhang,,OpenAI,Researcher,07 Jul 2024
Marcus,"Johnson, CFA, CPA",https://www.linkedin.com/in/marcus-johnson,,J.P. Morgan,Associate,08 Aug 2024
Aisha,Mohammed - Deloitte,https://www.linkedin.com/in/aisha-mohammed,,Deloitte Consulting LLP,Consultant,09 Sep 2024
Liam,O’Connor,https://www.linkedin.com/in/liam-oconnor,,Citi,Analyst,10 Oct 2023
Zoë,Müller,https://www.linkedin.com/in/zoe-muller,,Spotify,Data Scientist,11 Nov 2023
Robert,"Brown, Sr.",https://www.linkedin.com/in/robert-brown-sr,,Boeing,Director,12 Dec 2023
Kevin,van der Berg,https://www.linkedin.com/in/kevin-vdb,,Booking.com,Engineer,13 Jan 2024
Hannah,Lee ✨,https://www.linkedin.com/in/hannah-lee,,Notion,Product Designer,14 Feb 2024
Jean-Luc,Picard,https://www.linkedin.com/in/jl-picard,,Starfleet,Captain,15 Mar 2024
Mary Ann,Smith,https://www.linkedin.com/in/mary-ann-smith,,Pfizer,Scientist,16 Apr 2024
"Prof. Alan",Turing PhD,https://www.linkedin.com/in/alan-turing,,University of Manchester,Professor,17 May 2024
Fatima,Al-Sayed,https://www.linkedin.com/in/fatima-al-sayed,,EY,Senior Consultant,18 Jun 2024
DeShawn,Williams,https://www.linkedin.com/in/deshawn-williams,,Nike,Brand Manager,19 Jul 2024
Siobhán,MacDonald,https://www.linkedin.com/in/siobhan-macdonald,,Google,UX Researcher,20 Aug 2024
Nguyễn,Văn An,https://www.linkedin.com/in/nguyen-van-an,,VinAI,Engineer,21 Sep 2024
Rahul,Sharma (He/Him),https://www.linkedin.com/in/rahul-sharma,,Amazon Web Services,Solutions Architect,22 Oct 2024
Ms. Grace,Hopper,https://www.linkedin.com/in/grace-hopper,,US Navy,Rear Admiral,23 Nov 2024
Emily,"Chen, P.E.",https://www.linkedin.com/in/emily-chen-pe,,Tesla,Mechanical Engineer,24 Dec 2024
Carlos,García Márquez,https://www.linkedin.com/in/carlos-garcia-marquez,,Mercado Libre,Product Manager,25 Jan 2025
Olivia,"Davis, MBA (she/her)",https://www.linkedin.com/in/olivia-davis,,Boston Consulting Group (BCG),Consultant,26 Feb 2025
`;

export const MESSY_CONNECTIONS_EXPECT: { first: string; full: string; org: string }[] = [
  { first: 'Sam', full: 'Sam Lee', org: 'acme' },
  { first: 'John', full: 'John Smith', org: 'stripe' },
  { first: 'José', full: 'José Núñez-García', org: 'bain' },
  { first: 'Priya', full: 'Priya Patel', org: 'figma' },
  { first: 'Elena', full: 'Elena Rodriguez', org: 'mckinsey' },
  { first: 'Daniel', full: 'Daniel Kim', org: 'stripe' },
  { first: 'Maya', full: 'Maya Wu', org: 'figma' },
  { first: 'Christopher', full: "Christopher O'Brien", org: 'goldman sachs' },
  { first: 'Tom', full: 'Tom Wu', org: 'datadog' },
  { first: 'Ana', full: 'Ana de la Cruz', org: 'pwc' },
  { first: 'Wei', full: 'Wei Zhang', org: 'openai' },
  { first: 'Marcus', full: 'Marcus Johnson', org: 'jpmorgan chase' },
  { first: 'Aisha', full: 'Aisha Mohammed', org: 'deloitte' },
  { first: 'Liam', full: 'Liam O’Connor', org: 'citi' },
  { first: 'Zoë', full: 'Zoë Müller', org: 'spotify' },
  { first: 'Robert', full: 'Robert Brown', org: 'boeing' },
  { first: 'Kevin', full: 'Kevin van der Berg', org: 'booking com' },
  { first: 'Hannah', full: 'Hannah Lee', org: 'notion' },
  { first: 'Jean-Luc', full: 'Jean-Luc Picard', org: 'starfleet' },
  { first: 'Mary', full: 'Mary Ann Smith', org: 'pfizer' },
  { first: 'Alan', full: 'Alan Turing', org: 'university of manchester' },
  { first: 'Fatima', full: 'Fatima Al-Sayed', org: 'ey' },
  { first: 'DeShawn', full: 'DeShawn Williams', org: 'nike' },
  { first: 'Siobhán', full: 'Siobhán MacDonald', org: 'google' },
  { first: 'Nguyễn', full: 'Nguyễn Văn An', org: 'vinai' },
  { first: 'Rahul', full: 'Rahul Sharma', org: 'amazon web services' },
  { first: 'Grace', full: 'Grace Hopper', org: 'us navy' },
  { first: 'Emily', full: 'Emily Chen', org: 'tesla' },
  { first: 'Carlos', full: 'Carlos García Márquez', org: 'mercado libre' },
  { first: 'Olivia', full: 'Olivia Davis', org: 'boston consulting group' },
];
