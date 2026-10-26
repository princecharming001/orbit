declare module 'vader-sentiment' {
  const vader: {
    SentimentIntensityAnalyzer: {
      polarity_scores(text: string): { neg: number; neu: number; pos: number; compound: number };
    };
  };
  export default vader;
}
