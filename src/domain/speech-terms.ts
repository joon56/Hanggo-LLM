/** Things a dog can really tear. Anywhere in the sentence, these make 찢 mean what it says. */
const TEARABLE = '장난감|이불|휴지|종이|방석|쿠션|인형|옷|신발';
/** Things a person can really build or touch. These only count right before the verb, since they also come up in barking stories. */
const REAL_OBJECTS = `${TEARABLE}|집|밥|공사|농사|표정|미소|약|글|줄|이름|땅|바닥|손|발`;
const GEAR_CONTEXT = /줄|산책|채우|채워|착용|써\s*봤|쓰고|벗/;
const DOMAIN_TERMS = ['짖', '매트', '간식', '초인종', '산책', '하네스', '목줄', '훈련', '으르렁', '절뚝', '배변', '사료', '현관', '보호자'];

const BARK = /(찢|짓|짚)(어요|어서|었어요|었고|었는데|었|는|나요|기|으면|고|지)/g;
const tearableNamed = new RegExp(`(?<![가-힣])(?:${TEARABLE})`);
const objectRightBefore = new RegExp(`(?<![가-힣])(?:${REAL_OBJECTS})[을를은는]?\\s$`);
const OBJECT_PARTICLE = /[가-힣][을를]\s/;
// An object before one of these belongs to an earlier verb, as in 사람을 보면 짖어요.
const CLAUSE_END = /(?:면|서|니까|는데|때)\s/;
const ABOUT_BARKING = /짖|초인종|택배|현관|소리|흥분|횟수|다른\s*개|낯선|벨|오래|계속|다시|많이|자꾸|또/;

function meansWhatItSays(wrong: string, before: string, sentence: string) {
  if (OBJECT_PARTICLE.test(before.split(CLAUSE_END).at(-1)!) || objectRightBefore.test(before)) return true;
  // 짚 and 짓 have everyday meanings of their own, so they also need the sentence to be about barking.
  return wrong === '찢' ? tearableNamed.test(before) : !ABOUT_BARKING.test(sentence);
}

/**
 * Fixes words this speech model mishears in dog coaching, measured on the golden dialogues. Each rule is deliberately narrow,
 * and the caller keeps the model's own words as the original, so the trainer can always see what was actually heard.
 */
export function correctTerms(heard: string) {
  // Sentence by sentence, because what tells these apart is whether something is being torn or built, and that may be several words back.
  let text = heard.split(/(?<=[.?!])/).map(sentence => sentence.replace(BARK, (match, wrong: string, ending: string, offset: number) =>
    meansWhatItSays(wrong, sentence.slice(0, offset), sentence) ? match : `짖${ending}`)).join('');
  text = text.replace(/메트(?=로\s*(?:가|보|이동|올라|앉)|에|를|을|위|로\s)/g, '매트').replace(/메트$/g, '매트');
  text = text.replace(/한에스|하네수|한네스/g, '하네스');
  if (GEAR_CONTEXT.test(text)) text = text.replace(/한혜수(?!\s?(?:씨|님))/g, '하네스');
  return text;
}

/** How many mentions of the words this service depends on survived transcription. Exact text error rates hide these. */
export function termRecall(reference: string, heard: string) {
  const count = (text: string, term: string) => text.split(term).length - 1;
  const missed: Record<string, number> = {};
  let found = 0; let total = 0;
  for (const term of DOMAIN_TERMS) {
    const expected = count(reference, term);
    if (!expected) continue;
    const kept = Math.min(expected, count(heard, term));
    total += expected; found += kept;
    if (kept < expected) missed[term] = expected - kept;
  }
  return { found, total, missed };
}
