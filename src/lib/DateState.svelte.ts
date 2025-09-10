// Centralized date-related session state using Svelte 5 runes
// Exposes: selected_day, day_list, today_str, is_today_selected
// Keep ONLY date/day selection concerns here (no filesystem handles or photos)

class DateState {
	selected_day = $state('');
	day_list = $state<string[]>([]);

	// Derived current local date in YYYY-MM-DD format
	today_str = $derived.by(() => {
		const d = new Date();
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	});

	// Convenience flag
	is_today_selected = $derived.by(() => this.selected_day === this.today_str);

	setSelectedDay(day: string) {
		this.selected_day = day;
	}

	setDayList(list: string[]) {
		this.day_list = list;
	}
}

export const dateState = new DateState();
