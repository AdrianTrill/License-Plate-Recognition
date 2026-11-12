#pragma once

// A minimal test harness: each test is a function that throws on failure, and run() reports them all.

#include <cmath>
#include <cstddef>
#include <exception>
#include <functional>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace check {

class Failure : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

inline void expect(bool condition, const std::string& message) {
    if (!condition) {
        throw Failure(message);
    }
}

template <typename Actual, typename Expected>
void expect_equal(const Actual& actual, const Expected& expected, const std::string& message) {
    if (!(actual == expected)) {
        std::ostringstream stream;
        stream << message << " (expected " << expected << ", got " << actual << ')';
        throw Failure(stream.str());
    }
}

inline void expect_near(double actual, double expected, double tolerance, const std::string& message) {
    if (!(std::fabs(actual - expected) <= tolerance)) {
        std::ostringstream stream;
        stream << message << " (expected " << expected << " within " << tolerance << ", got " << actual << ')';
        throw Failure(stream.str());
    }
}

template <typename Exception, typename Body>
void expect_throws(Body&& body, const std::string& message) {
    try {
        body();
    } catch (const Exception&) {
        return;
    } catch (const std::exception& error) {
        throw Failure(message + " (threw something else: " + error.what() + ")");
    }
    throw Failure(message + " (did not throw)");
}

struct Test {
    const char* name;
    std::function<void()> body;
};

inline int run(const std::vector<Test>& tests) {
    std::size_t failures = 0;
    for (const Test& test : tests) {
        try {
            test.body();
            std::cout << "ok    " << test.name << '\n';
        } catch (const std::exception& error) {
            ++failures;
            std::cout << "FAIL  " << test.name << ": " << error.what() << '\n';
        }
    }
    std::cout << (tests.size() - failures) << " of " << tests.size() << " tests passed\n";
    return failures == 0 ? 0 : 1;
}

}  // namespace check
