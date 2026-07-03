/**
 * Adjective-animal name generator for pim instances (e.g. "lucid-heron"),
 * used when the user doesn't pick a name at spawn. Backed by
 * unique-names-generator's dictionaries (~1400 adjectives, ~350 animals).
 */

import { adjectives, animals, uniqueNamesGenerator } from "unique-names-generator";

/** Generate a name not already in use; falls back to a suffixed variant. */
export function generateInstanceName(taken: ReadonlySet<string>): string {
	const generate = () => uniqueNamesGenerator({ dictionaries: [adjectives, animals], separator: "-", length: 2 });

	let name = generate();
	for (let attempt = 0; attempt < 20 && taken.has(name); attempt++) {
		name = generate();
	}
	if (!taken.has(name)) {
		return name;
	}
	let counter = 2;
	while (taken.has(`${name}-${counter}`)) {
		counter++;
	}
	return `${name}-${counter}`;
}
