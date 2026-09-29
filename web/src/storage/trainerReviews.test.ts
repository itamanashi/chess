import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadTrainerReviews,
  saveTrainerReviews,
  scheduleTrainerReview,
  summarizeTrainerReviews,
  TrainerRating,
  TRAINER_DISCOVERY_BATCH_SIZE,
} from './trainerReviews';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FSRS trainer reviews', () => {
  it('stores FSRS cards and only counts unhinted success as learned', () => {
    const now = Date.UTC(2026, 0, 1);
    const hinted = scheduleTrainerReview(undefined, TrainerRating.Hard, now);
    const learned = scheduleTrainerReview(hinted, TrainerRating.Good, now + 60_000);
    const missed = scheduleTrainerReview(learned, TrainerRating.Again, now + 120_000);

    expect(hinted.learned).toBe(false);
    expect(learned.learned).toBe(true);
    expect(missed.learned).toBe(true);
    expect(missed.card.reps).toBe(3);
    expect(missed.card.due).toEqual(expect.any(String));
    expect(Date.parse(missed.card.due)).toBeGreaterThan(now + 120_000);
    expect(() => scheduleTrainerReview(undefined, TrainerRating.Manual, now))
      .toThrow('Une note FSRS manuelle ne planifie pas de révision.');
  });

  it('unlocks the next cohort only after ten positions are learned', () => {
    const now = Date.UTC(2026, 0, 1);
    const positions = Array.from({ length: 25 }, (_, index) => `position-${index + 1}`);
    const firstCohort = Object.fromEntries(
      positions.slice(0, TRAINER_DISCOVERY_BATCH_SIZE)
        .map((key) => [key, scheduleTrainerReview(undefined, TrainerRating.Good, now)]),
    );
    const secondCohort = summarizeTrainerReviews(firstCohort, positions, now);

    expect(secondCohort).toMatchObject({
      learned: 10,
      batchNumber: 2,
      batchLearned: 0,
      batchSize: 10,
      unlockedPositions: 20,
    });
    expect(secondCohort.newPositionKeys).toEqual(positions.slice(10, 20));

    const threeMore = { ...firstCohort };
    for (const key of positions.slice(10, 13)) {
      threeMore[key] = scheduleTrainerReview(undefined, TrainerRating.Good, now);
    }
    expect(summarizeTrainerReviews(threeMore, positions, now)).toMatchObject({
      learned: 13,
      batchNumber: 2,
      batchLearned: 3,
      unlockedPositions: 20,
    });
  });

  it('prioritizes due cards and reports the next scheduled review', () => {
    const now = Date.UTC(2026, 0, 1);
    const reviews = {
      due: scheduleTrainerReview(undefined, TrainerRating.Good, now - 60 * 24 * 60 * 60 * 1000),
      later: scheduleTrainerReview(undefined, TrainerRating.Good, now),
    };

    const summary = summarizeTrainerReviews(reviews, ['due', 'later', 'new'], now);
    expect(summary.duePositionKeys).toEqual(['due']);
    expect(summary.newPositionKeys).toEqual(['new']);
    expect(summary.nextDueAt).toBeGreaterThan(now);
  });

  it('persists FSRS cards and ignores malformed records', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const review = scheduleTrainerReview(undefined, TrainerRating.Good, 1_000);

    expect(saveTrainerReviews({ 'rep::position': review })).toBe(true);
    expect(loadTrainerReviews()).toEqual({ 'rep::position': review });

    values.set('chess_trainer_reviews_v1', JSON.stringify({
      'rep::position': review,
      broken: { card: { due: 'yesterday' }, learned: false },
    }));
    expect(loadTrainerReviews()).toEqual({ 'rep::position': review });
  });
});
