import { Container, SelectList, Text } from '@earendil-works/pi-tui'

/** Select prompt that remains in the turn timeline after it is answered. */
export class InlineSelectPrompt extends Container {
  focused = false
  private choicesVisible = true
  private result?: Text

  constructor(
    title: string,
    private readonly choices: SelectList,
  ) {
    super()
    this.addChild(new Text(title, 1, 0))
    this.addChild(choices)
  }

  handleInput(data: string): void {
    if (this.choicesVisible) this.choices.handleInput(data)
  }

  complete(result: string): void {
    if (this.choicesVisible) {
      this.removeChild(this.choices)
      this.choicesVisible = false
    }
    if (this.result) this.removeChild(this.result)
    this.result = new Text(result, 1, 0)
    this.addChild(this.result)
  }
}
