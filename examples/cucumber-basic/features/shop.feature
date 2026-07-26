Feature: shop

  Two scenarios in one feature file that execute different sources, so covsel
  can select just the scenario a change affects.

  Scenario: totalling a cart
    When I total the prices 2 and 3
    Then the total is 5

  Scenario: greeting a customer
    When I greet "Ada"
    Then the greeting is "Hello, Ada!"
