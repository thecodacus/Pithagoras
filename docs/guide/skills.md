# Skills

A skill is a set of instructions the agent pulls in when its description
matches what is being asked. It is a directory with one `SKILL.md` in it: a
short frontmatter with a name and a description, then the steps in markdown.
Every session sees the same skills, so they are the place for a procedure you
would otherwise explain again, such as how you like releases cut or the shape of
a good commit message.

Settings → Agent → **Skills** is the page for them. The list is pi's own, the
one a session loads, so what is shown there is what the agent is offered. A
skill the page says is loaded is loaded.

## Where they live

Your own skills are directories under `skills/` in pi's agent directory
(`~/.pi/agent/skills`, or `PI_CODING_AGENT_DIR` when set). The path is printed
at the top of the page. Two more kinds are listed under **Built in and from
packages**, and both are read-only:

- skills the portal ships, loaded from the image, such as `skill-creator`, see
  [Built-in skills](/guide/extensions#built-in-skills)
- skills that arrived with an installed [extension package](/guide/extensions)

A package owns its skills. Editing one in place would be undone by the next
update without saying so, so change it by removing or replacing the package.

## What the model reads

Only the **description** decides whether a skill applies. The model sees the
name and the description of every skill, and reads the rest of `SKILL.md` only
once it picks one. So a description says _when_ to use the skill, not what it
contains: "Use when cutting a release: version bump, changelog, tag and push".

A skill marked **/skill only** is never picked by the model on its own. It runs
when you type it, as `/skill:name`, see [Slash commands](/guide/commands).

## Create one

**+ New** asks for a name and a "When to use it" sentence and writes a first
`SKILL.md` you then edit in the same page. The name becomes the directory name
(lower case, dashes). The description is required, and is always written quoted:
a sentence contains colons, and an unquoted one is not valid YAML, which makes
pi drop the skill with a parse warning.

You can also ask the agent to write one. The built-in `skill-creator` skill
teaches it the format and where a skill has to go to load.

## Import from GitHub

**Import from GitHub** takes what you would paste: `user/repo`,
`user/repo#branch`, `user/repo/sub/dir`, a repository URL, or the address of a
folder copied from the browser (`…/tree/main/skills/foo`). **Look** clones the
repository shallowly and lists every skill found in it, without installing
anything. You tick the ones you want and press **Import**.

- A skill you already have is marked _installed_ and skipped, unless you tick it
  again. A ticked skill you already have is replaced, including any edits you
  made to it. A replacement is made whole or not at all: if it cannot be put in
  place, the skill you had is left as it was.
- What you import is the version **Look** showed, even if the branch has moved
  on since. Changing the address drops the list, so what you tick always belongs
  to the address above it.
- What is not taken is listed under **Not imported**, with the reason: a name
  that is not a plain folder name (`..`, or one with a slash), two skills with
  the same name, or one that is no longer in the repository.
- Links inside a repository are never followed or copied, so a repository cannot
  point a skill at your files.
- Nothing is executed by an import. A skill is markdown, but it is markdown the
  agent will follow, so import only from somewhere you would take instructions
  from.
- The origin is remembered beside the skill, so an imported skill gets an
  **Update** button that fetches only that skill again from where it came from,
  replacing local edits. When the skill is no longer in the repository under
  that name, **Update** says so rather than doing nothing.

### Private repositories

A private repository is reached through the git login of the server, not through
the page: configure a credential helper for the server's git (`gh auth
setup-git`, or `git config --global credential.helper store`; in the image
`HOME` is `/data/home`, so it persists). An address with a login or token in it
(`https://token@github.com/…`) is refused, and nothing here stores or shows one.
With no login configured, a private repository answers _Not found, or private_
at once instead of waiting for a password nobody can type.

## Switch off, edit, delete

Open a skill to see and edit its `SKILL.md`; **Save** writes it back.

- **Disable** stops pi loading the skill at all, rather than hiding it on this
  page. The file is renamed to `SKILL.md.disabled`, so everything else in the
  directory stays and **Enable** is the same move back. A disabled skill is shown
  as _off_.
- A skill pi cannot parse, usually because of broken frontmatter, is listed too,
  marked as not loading, with the warning pi gave. It is invisible to the
  agent until the frontmatter is fixed, and it can be edited or deleted here.
- **Delete** removes the skill's directory after a confirmation. A skill that is
  a single `.md` file in the skills folder itself (see the tip below) is deleted
  as that file alone, and cannot be switched off from here.

Two skills with the same name, or a file pi cannot read, are reported as
warnings at the top of the page.

::: tip A skills directory holds directories
pi treats any `.md` file sitting directly in a skills root as a skill in its own
right. A stray README there is reported as a broken skill. Keep the root to
directories only.
:::

## API

The routes are in the [API reference](/reference/api#skills).
