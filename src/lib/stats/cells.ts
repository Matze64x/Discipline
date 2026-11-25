/** How a habit's day looks in the stats (calendar, week dots) and reads when tapped. */
import { goalOn, weekday, type CivilDate, type DayCell, type Habit } from '../../core';
import { formatShortDate, weekdayName, withUnit } from '../display';

/** The CSS class of a day cell (`.cell` in app.css) and its `--fill` */
export function cellLook(cell: DayCell): { kind: string; fill: number } {
	const ring = cell.state === 'open' ? ' open' : '';
	if (cell.fill > 0) return { kind: `some${ring}`, fill: cell.fill };
	switch (cell.state) {
		case 'missed':
			return { kind: 'missed', fill: 0 };
		case 'free':
			return { kind: 'empty', fill: 0 };
		case 'open':
			return { kind: 'open', fill: 0 };
		case 'notDue':
			return { kind: 'off', fill: 0 };
		default:
			return { kind: 'none', fill: 0 };
	}
}

/** "Wed 12.11.: 5 min", "Mon 3.11.: done"; limits: "Tue 4.11.: slipped", "Thu 6.11.: 3 cups (over)" */
export function describeCell(cell: DayCell, date: CivilDate, habit: Habit): string {
	const day = `${weekdayName(weekday(date))} ${formatShortDate(date)}`;
	if (cell.state === 'inactive') return `${day}: –`;
	const limit = goalOn(habit, date)?.aim === 'limit';
	if (habit.kind === 'check') {
		const state = limit
			? cell.value > 0
				? 'slipped'
				: cell.state === 'notDue'
					? 'not due'
					: cell.state === 'open' || cell.state === 'free' && cell.fill === 0
						? 'kept so far'
						: 'kept'
			: cell.value > 0
				? 'done'
				: cell.state === 'missed'
					? 'missed'
					: cell.state === 'notDue'
						? 'not due'
						: 'not done';
		return `${day}: ${state}`;
	}
	if (cell.state === 'notDue' && cell.value === 0) return `${day}: not due`;
	return `${day}: ${withUnit(cell.value, habit.unit)}${limit && cell.state === 'missed' ? ' (over)' : ''}`;
}
