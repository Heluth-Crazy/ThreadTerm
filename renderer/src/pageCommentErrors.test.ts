import assert from 'node:assert/strict';
import test from 'node:test';
import { pageCommentErrorMessage } from './pageCommentErrors';

const unusablePick = new Error("Error invoking remote method 'threadterm:pick-page-target': Error: Invalid page comment string");

test('an unusable picker selection has a short actionable recovery in both languages', () => {
 assert.equal(pageCommentErrorMessage(unusablePick, false), 'That element can’t be identified. Select another element or its parent, or drag an area.');
 assert.equal(pageCommentErrorMessage(unusablePick, true), '无法识别所选元素。请选择其他元素、它的父级，或拖动选择一个区域。');
});

test('only the exact picker IPC validation failure gets picker recovery copy', () => {
 for (const value of [
  new Error('Invalid page comment string'),
  new Error("Error invoking remote method 'threadterm:pick-page-target': Error: Invalid page comment string: page details"),
  new Error("Error invoking remote method 'threadterm:browser-handoff': Error: Invalid page comment string"),
  'untrusted raw page content',
 ]) assert.equal(pageCommentErrorMessage(value, false), 'The page comment could not be completed.');
});

test('review-comment validation messages stay specific', () => {
 assert.equal(pageCommentErrorMessage(new Error('review_comments_full'), false), 'This folder already has 200 comments. Add them to the message or remove some first.');
 assert.equal(pageCommentErrorMessage(new Error('review_comment_empty'), true), '请先填写审查意见。');
 assert.equal(pageCommentErrorMessage(new Error('review_comment_too_long'), false), 'A comment can be at most 4000 characters.');
});
