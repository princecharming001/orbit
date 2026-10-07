/**
 * A broad list of given names, lowercase, used to tell a name typed in lowercase ("priya shah") from a phrase
 * ("career services"). It spans the names students meet in recruiting: US and UK, Spanish and Portuguese, South
 * Asian, Chinese (pinyin), Korean, Japanese, Vietnamese, Arabic and Persian, West and East African, European and
 * Hebrew. It does not need to be complete: a name missing from it is still saved when typed with capitals, and is
 * offered for confirmation when typed in lowercase.
 */
const LIST = [
  // US and UK
  'aaron abigail ada adam addison adrian aiden alan albert alex alexa alexander alexandra alexis alfie alice alicia',
  'alison allison alyssa amanda amber amelia amy andrew andy angela angelina angus anna annabelle anne annie anthony',
  'archie ariana arthur ashley aubrey audrey austin ava avery barbara beatrice becky ben benjamin beth bethany betty',
  'beverly blake bobby brad bradley brady brandon brayden brenda brett brian brianna bridget brittany brooke bruce',
  'bryan caitlin caleb callum cameron camille carl carla carol caroline carolyn carter casey catherine charlie',
  'charles charlotte chelsea cheryl chloe chris christian christina christine christopher cindy claire clara',
  'clayton cody colin colleen connor conor cooper courtney craig crystal curtis cynthia daisy dakota dale dana',
  'daniel danielle danny darren dave david dean deborah debra declan dennis derek devin devon diana diane dominic',
  'donald donna doris dorothy douglas drew dustin dylan easton edward elaine eleanor eli elijah elizabeth ella ellie',
  'emerson emily emma eric erica erin ethan eugene evan evelyn everly ezra faith felicity finley finn fiona frances',
  'frank fraser freddie frederick gabriel gabrielle garrett gary gavin gemma george georgia gerald gianna gillian',
  'glenn gloria grace graham grant grayson greg gregory hailey haley hannah harold harper harriet harry hayden',
  'hazel heather helen henry holly hope howard hudson hugh hunter ian imogen iris isaac isabel isabella isabelle',
  'isla ivy jack jackson jacob jacqueline jaden jake james jamie jane janet janice jared jasmine jason jasper jay',
  'jayden jean jeff jeffrey jenna jennifer jenny jeremy jerry jess jesse jessica jessie jill jim jimmy joan joanna',
  'joe joel joey john johnny jon jonathan jordan josephine joseph josh joshua joy joyce judith judy julia julian',
  'julie june justin kaitlyn karen kate katelyn katherine kathleen kathryn kathy katie kayla kaylee keith kelly',
  'kelsey ken kendall kenneth kennedy kevin kim kimberly kinsley kirsten krista kristen kristin kyle lance landon',
  'larry laura lauren lawrence layla leah lee leo levi liam lily lincoln linda lindsay lindsey lisa logan lori',
  'louis lucas lucy luke lydia mackenzie madeline madelyn madison maggie mandy marcus margaret margot maria mariah',
  'marie marilyn marissa mark martha martin mary mason matt matthew maureen max maxwell megan melanie melissa',
  'meredith mia micah michael michelle mike miles mitchell molly monica morgan nancy naomi natalie nate nathan',
  'nathaniel neil nicholas nick nicole noah nolan nora oliver olivia oscar owen paige pamela parker patricia',
  'patrick paul paula penelope peter peyton phil philip phoebe piper poppy preston priscilla quinn rachel ralph',
  'randy ray raymond rebecca reese riley rob robert robin roger ronald rory rose ross rowan roy ruby russell ruth',
  'ryan sadie sage sally samantha samuel sandra sara sarah savannah sawyer scarlett scott sean seth shane shannon',
  'sharon shawn shelby shirley sienna silas skylar sophia sophie spencer stacy stella stephanie stephen steve',
  'steven stewart stuart summer susan sydney tanner tara taylor ted teresa terry tessa theo theodore theresa thomas',
  'tiffany tim timothy tina toby todd tom tommy tony tracy travis trevor tristan troy tyler valerie vanessa',
  'veronica victor victoria vincent violet virginia walter wayne wendy wesley whitney will william willow wyatt',
  'zach zachary zack zoe zoey',
  // short forms people type for each other
  'abby becca dan doug ed eddie fred jen liz meg mikey nina ollie pete rick ricky sam stevie tess val vic vince',
  // Spanish and Portuguese
  'adriana agustin alberto alejandra alejandro alfonso alvaro ana andres angel antonia antonio arturo beatriz',
  'camila carlos carmen catalina cesar cristina daniela diego dolores eduardo elena emilio enrique esteban fernanda',
  'fernando francisco gabriela graciela guadalupe guillermo gustavo hector ignacio ines javier jimena joaquin',
  'jorge jose josefina juan juana julieta julio leonardo lorena lorenzo lucia luciana luis manuel marcela marco',
  'mariana marisol mateo mercedes miguel natalia nicolas pablo paloma pedro pilar rafael ramon raul renata ricardo',
  'rodrigo rosa ruben santiago sebastian sergio sofia tomas valentina valeria ximena yesenia joao thiago gabriel',
  'beatriz goncalo rafaela leticia vitoria tiago nuno caio rafa iker gio nico enzo bruno lola',
  // South Asian
  'aarav abhishek aditi aditya aishwarya ajay akash alok amit amrita anand ananya anil anita anjali ankit ankita',
  'anushka aparna archana arjun arun aryan ashok ashwin avani ayush bhavna chitra deepa deepak dev devika dhruv',
  'divya gaurav gayatri geeta gopal hari harsh heena isha ishaan jayesh jyoti kajal kavya karan karthik keerthi',
  'kiran krishna kunal lakshmi lavanya madhu manish mansi meena meenakshi meera mohan murali nandini naresh naveen',
  'neha nikhil nisha nitin padma pallavi pooja pranav prakash prasad pratik preeti priya priyanka radha raghav',
  'rahul raj rajesh rakesh ramesh rashmi ravi revathi rishi ritu riya rohan rohit sachin sameer sana sandeep',
  'sanjana sanjay santosh sapna satish seema shalini shilpa shiv shreya shruti shyam siddharth sid sneha sonal',
  'sonia sowmya sriram srinivas sudha sunil sunita suresh swati tanvi tanya tarun trisha uday usha vandana varun',
  'venkat vijay vikram vinay vishal vivek yash yamini zara harini kriti nikita parth pranavi riddhi tanish vedant',
  // Chinese (pinyin)
  'bo chen fang feng hao hong hua hui jia jiahui jian jiawei jiayi jie jing jun junjie kaiwen lan lei li lin ling',
  'mei meiling ming mingyu na qian qing rui ruoxi shan shuang siyu tao tianyi ting wei wenjie xiao xiaoming xiaoyu',
  'xin xinyi xue yan yang yi yichen yifan ying yu yun yutong yuting yuxuan zhi zhiwei zihan zixuan haoran',
  // Korean, Japanese, Vietnamese
  'minjun min-jun jiwoo ji-woo seoyeon seo-yeon jimin ji-min hyun hyunwoo hyun-woo sungmin sung-min jisoo ji-soo',
  'yuna eunji eun-ji minji min-ji jihoon ji-hoon soyeon so-yeon taeyang hana jaehyun jae-hyun seojun seo-jun',
  'haruto yuto sota yuki hiro hiroshi takeshi kenji satoshi daiki ryo kenta akira yuko yumi aiko emi sakura yui',
  'mio rin keiko naoko mai saki kaori haruka takumi riku shota sora ren jae ji soo eun seo min',
  'anh bao duc hai hieu hoa hung huong khanh lan linh long mai minh ngoc phuong quang tam thanh thao trang trung',
  'tuan van vy',
  // Arabic, Persian, Turkish
  'ahmad ahmed aisha ali amina amir ayman bilal dina farah faisal fatima hamza hana hassan hiba huda hussein',
  'ibrahim karim khalid layla leila lina mariam maryam mohamed mohammad mohammed muhammad nabil noor nour omar',
  'rami rania reem salma samir sara tariq yasmin yasmine youssef yusuf zainab ziad arash darius dariush kian',
  'leyla mehdi nasrin parisa reza roya shirin emre elif zeynep mehmet ayse can idris dara navid yara',
  // West, East and Southern African
  'abena ada adaeze adebayo ade akua ama amara amani baraka chidi chinedu chioma chinonso emeka femi folake imani',
  'jabari kofi kwame kwesi lerato ngozi nneka obinna oluwaseun segun sipho thabo thandiwe tunde wanjiru yetunde',
  'zanele zuri efua kojo yaw tendai tariro amaka ifeoma uchenna olu seun yemi bola kemi tobi dayo uche obi wale',
  'kunle funmi esi akosua',
  // European
  'agnieszka alessandro alessia amelie anastasia anders antoine astrid bjorn chiara dmitri elisa elsa erik federico',
  'francesca giovanni giulia giuseppe greta ida ingrid irina ivan jakub jan johan jonas julien katarzyna katya',
  'klara lars lea lena leon luca lukas magda manon martina mathieu matteo maximilian mikhail moritz niklas nikolai',
  'nils olaf olga piotr pierre sergei svetlana sven tatiana tomasz yulia zofia nikos dimitris eleni aoife niamh',
  'siobhan ciara saoirse cormac oisin sinead padraig pieter joost sanne femke annelies henrik mats freja liv saga',
  'elias emil hugo felix oskar viktor marta lucie tereza petra kristof andras gergely',
  // Hebrew
  'avi yosef moshe eitan noa tamar shira yael talia ari',
  // gender-neutral and newer names
  'alexis ari blair charlie dakota eden ellis emerson finley harley jules kai kendall marley noel reagan remy',
  'river rory sasha sky skyler tatum',
].join(' ');

const GIVEN = new Set(LIST.split(/\s+/).filter(Boolean));

/**
 * Given names that are also everyday words or places ("will", "may", "mark", "grant", "austin"). Typed with a
 * capital they count as names; typed in lowercase the phrase is only offered for confirmation.
 */
export const WORDLIKE_GIVEN = new Set(
  [
    'will may mark bill grace hope faith joy rich sunny art summer april june august dawn rose frank pat sue max',
    'gene chase hunter carter cash angel sky river reed drew ray rob jack miles lane grant sage dean dale glenn',
    'guy jay page holly ivy iris daisy violet hazel amber crystal autumn penny chip buck rusty sterling wade earl',
    'royal christian dallas houston paris london sydney georgia carolina virginia savannah brooklyn',
    'chelsea india phoenix florence dakota bo li na yu can long van lan mai hana ada sid noel min',
  ]
    .join(' ')
    .split(' '),
);

/** "priya", "Ji-woo" (by its first part), "José" (accents ignored). */
export function isGivenName(word: string): boolean {
  const w = word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return GIVEN.has(w) || GIVEN.has(w.split('-')[0]!);
}
