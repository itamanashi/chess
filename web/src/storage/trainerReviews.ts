import { createEmptyCard, fsrs, Rating, State, type Card } from 'ts-fsrs';
import { readRaw, writeRaw } from './storage';
import { warn } from '../utils/async';

const STORAGE_KEY = 'chess_trainer_reviews_v1';
export const TRAINER_DISCOVERY_BATCH_SIZE = 10;

const scheduler = fsrs({
  request_retention: 0.9,
  enable_fuzz: true,
  maximum_interval: 36500,
});

interface StoredCard extends Omit<Card, 'due' | 'last_review'> {
  due: string;
  last_review?: string;
}

export interface TrainerReview {
  card: StoredCard;
  learned: boolean;
}

export type TrainerReviews = Record<string, TrainerReview>;

export interface TrainerReviewSummary {
  due: number;
  learned: number;
  nextDueAt: number | null;
  duePositionKeys: string[];
  newPositionKeys: string[];
  batchNumber: number;
  batchLearned: number;
  batchSize: number;
  totalPositions: number;
  unlockedPositions: number;
}

function isStoredCard(value: unknown): value is StoredCard {
  if (!value || typeof value !== 'object') return false;
  const card = value as Partial<StoredCard>;
  return typeof card.due === 'string' && Number.isFinite(Date.parse(card.due))
    && Number.isFinite(card.stability) && Number.isFinite(card.difficulty)
    && Number.isInteger(card.elapsed_days) && Number.isInteger(card.scheduled_days)
    && Number.isInteger(card.learning_steps) && Number.isInteger(card.reps)
    && Number.isInteger(card.lapses) && Number.isInteger(card.state)
    && card.state! >= State.New && card.state! <= State.Relearning
    && (card.last_review === undefined
      || (typeof card.last_review === 'string' && Number.isFinite(Date.parse(card.last_review))));
}

function isReview(value: unknown): value is TrainerReview {
  return !!value && typeof value === 'object'
    && isStoredCard((value as Partial<TrainerReview>).card)
    && typeof (value as Partial<TrainerReview>).learned === 'boolean';
}

function hydrateCard(card: StoredCard): Card {
  return {
    ...card,
    due: new Date(card.due),
    last_review: card.last_review ? new Date(card.last_review) : undefined,
  };
}

function serializeCard(card: Card): StoredCard {
  return {
    ...card,
    due: card.due.toISOString(),
    last_review: card.last_review?.toISOString(),
  };
}

export function loadTrainerReviews(): TrainerReviews {
  const raw = readRaw(STORAGE_KEY);
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Format du planning FSRS invalide.');
    }
    return Object.fromEntries(
      Object.entries(value).filter(([key, review]) => key.length > 0 && isReview(review)),
    );
  } catch (error) {
    warn('trainer-reviews:parse', error);
    return {};
  }
}

export function scheduleTrainerReview(
  previous: TrainerReview | undefined,
  rating: Rating,
  now = Date.now(),
): TrainerReview {
  if (rating === Rating.Manual) throw new Error('Une note FSRS manuelle ne planifie pas de révision.');
  const review = scheduler.next(
    previous ? hydrateCard(previous.card) : createEmptyCard(now),
    now,
    rating,
  );
  return {
    card: serializeCard(review.card),
    learned: previous?.learned === true || rating === Rating.Good || rating === Rating.Easy,
  };
}

export function saveTrainerReviews(reviews: TrainerReviews): boolean {
  return writeRaw(STORAGE_KEY, JSON.stringify(reviews));
}

export function summarizeTrainerReviews(
  reviews: TrainerReviews,
  positionKeys: readonly string[],
  now = Date.now(),
): TrainerReviewSummary {
  const positions = [...new Set(positionKeys)];
  const positionSet = new Set(positions);
  const learnedKeys = new Set(
    positions.filter((key) => reviews[key]?.learned === true),
  );
  const learned = learnedKeys.size;
  const batchStart = positions.length === 0
    ? 0
    : Math.floor(Math.min(learned, positions.length - 1) / TRAINER_DISCOVERY_BATCH_SIZE)
      * TRAINER_DISCOVERY_BATCH_SIZE;
  const unlockedPositions = Math.min(
    positions.length,
    batchStart + TRAINER_DISCOVERY_BATCH_SIZE,
  );
  const batchSize = Math.min(TRAINER_DISCOVERY_BATCH_SIZE, positions.length - batchStart);
  const batchLearned = positions
    .slice(batchStart, batchStart + batchSize)
    .filter((key) => learnedKeys.has(key)).length;

  const duePositions: Array<{ key: string; dueAt: number }> = [];
  let nextDueAt: number | null = null;
  for (const [key, review] of Object.entries(reviews)) {
    if (!positionSet.has(key)) continue;
    const dueAt = Date.parse(review.card.due);
    if (dueAt <= now) duePositions.push({ key, dueAt });
    else if (nextDueAt === null || dueAt < nextDueAt) nextDueAt = dueAt;
  }
  duePositions.sort((a, b) => a.dueAt - b.dueAt);

  const unlocked = positions.slice(0, unlockedPositions);
  const newPositionKeys = unlocked.filter((key) => !reviews[key]);
  const duePositionKeys = duePositions.map(({ key }) => key);
  return {
    due: duePositionKeys.length,
    learned,
    nextDueAt,
    duePositionKeys,
    newPositionKeys,
    batchNumber: positions.length === 0 ? 0 : Math.floor(batchStart / TRAINER_DISCOVERY_BATCH_SIZE) + 1,
    batchLearned,
    batchSize,
    totalPositions: positions.length,
    unlockedPositions,
  };
}

export { Rating as TrainerRating };
